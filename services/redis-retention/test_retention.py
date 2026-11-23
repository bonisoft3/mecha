import json
import pathlib
import subprocess
import time
import unittest

IMAGE = 'redis:7.4.1-alpine@sha256:59b6e694653476de2c992937ebe1c64182af4728e54bb49e9b7a6c26614d8933'
SCRIPT = pathlib.Path(__file__).with_name('retain.lua').read_text()
INIT = pathlib.Path(__file__).with_name('init.lua').read_text()
MAX = '18446744073709551615'


def docker(*args, **kwargs):
    return subprocess.run(['docker', *args], check=True, text=True, capture_output=True, **kwargs).stdout.strip()


class Retention(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.container = docker('run', '-d', '--rm', '--network', 'none', IMAGE, 'redis-server', '--save', '', '--appendonly', 'no')
        for _ in range(100):
            try:
                if cls.cli('PING') == 'PONG':
                    return
            except subprocess.CalledProcessError:
                time.sleep(.1)
        docker('rm', '-f', cls.container)
        raise RuntimeError('Redis did not start')

    @classmethod
    def tearDownClass(cls):
        docker('rm', '-f', cls.container)

    @classmethod
    def cli(cls, *args):
        return docker('exec', cls.container, 'redis-cli', '-e', '--raw', *map(str, args))

    def setUp(self):
        self.cli('FLUSHALL')

    def fill(self, count=500):
        ms = int(time.time() * 1000) - 5000
        commands = ''.join(f'*5\r\n$4\r\nXADD\r\n$1\r\ns\r\n${len(str(ms)) + len(str(i)) + 1}\r\n{ms}-{i}\r\n$1\r\nf\r\n$1\r\nv\r\n' for i in range(1, count + 1))
        docker('exec', '-i', self.container, 'redis-cli', '--pipe', input=commands)
        return ms

    def retain(self, expected='g', limit='10000', mode='apply'):
        return json.loads(self.cli('EVAL', SCRIPT, '1', 's', expected, limit, mode))

    def init(self, expected='g', snapshot=''):
        return json.loads(self.cli('EVAL', INIT, '1', 's', expected, snapshot))

    def group(self, name='g', id='0'):
        self.cli('XGROUP', 'CREATE', 's', name, id)

    def test_registration_and_validation(self):
        self.assertEqual(self.init('g,other')['created'], ['g', 'other'])
        self.assertEqual(self.cli('XLEN', 's'), '0')
        self.cli('FLUSHALL')
        self.fill()
        self.cli('XDEL', 's', self.cli('XRANGE', 's', '-', '+', 'COUNT', '1').splitlines()[0])
        with self.assertRaises(subprocess.CalledProcessError):
            self.init('safe,unsafe', 'safe')
        self.assertEqual(self.cli('XINFO', 'GROUPS', 's'), '')
        self.assertEqual(self.init('safe', 'safe')['created'], ['safe'])
        self.cli('XGROUP', 'SETID', 's', 'safe', '$')
        before = self.cli('XINFO', 'GROUPS', 's')
        self.init('safe', '')
        self.assertEqual(self.cli('XINFO', 'GROUPS', 's'), before)

    def test_recent_acknowledged_stream_empties_and_limit_is_bounded(self):
        self.fill(250)
        self.group('g', '$')
        self.assertEqual(self.retain(mode='plan')['after'], 250)
        while int(self.cli('XLEN', 's')):
            result = self.retain(limit='30')
            self.assertGreater(result['trimmed'], 0)
            self.assertLessEqual(result['trimmed'], 30)
        self.assertEqual(self.retain()['trimmed'], 0)

    def test_pending_unread_and_extra_group(self):
        ms = self.fill()
        self.group('g')
        self.cli('XREADGROUP', 'GROUP', 'g', 'c', 'COUNT', '250', 'STREAMS', 's', '>')
        self.cli('XACK', 's', 'g', *[f'{ms}-{i}' for i in range(1, 201)])
        self.group('extra', f'{ms}-100')
        result = self.retain()
        self.assertEqual(result['boundary'], f'{ms}-100')
        self.assertTrue(result['boundary_inclusive'])
        self.assertEqual(result['blocking_group'], 'extra')
        self.cli('XGROUP', 'SETID', 's', 'extra', f'{ms}-350')
        result = self.retain()
        self.assertEqual(result['boundary'], f'{ms}-201')
        self.assertFalse(result['boundary_inclusive'])
        self.assertEqual(self.cli('XRANGE', 's', f'{ms}-201', f'{ms}-201').splitlines()[0], f'{ms}-201')
        self.assertEqual(self.cli('XRANGE', 's', f'{ms}-251', f'{ms}-251').splitlines()[0], f'{ms}-251')
        self.assertEqual(self.cli('XPENDING', 's', 'g').splitlines()[0], '50')

    def test_acknowledge_empty_and_resume_existing_group(self):
        ms = self.fill(1)
        self.group('g')
        entry = f'{ms}-1'
        self.assertIn(entry, self.cli('XREADGROUP', 'GROUP', 'g', 'c', 'COUNT', '1', 'STREAMS', 's', '>'))
        self.assertEqual(self.retain()['trimmed'], 0)
        self.cli('XACK', 's', 'g', entry)
        self.assertEqual(self.retain()['trimmed'], 1)
        self.assertEqual(self.cli('XLEN', 's'), '0')
        self.assertEqual(self.cli('TYPE', 's'), 'stream')
        self.assertIn('g', self.cli('XINFO', 'GROUPS', 's').splitlines())
        new_entry = f'{ms}-2'
        self.cli('XADD', 's', new_entry, 'f', 'v')
        self.assertIn(new_entry, self.cli('XREADGROUP', 'GROUP', 'g', 'c', 'COUNT', '1', 'STREAMS', 's', '>'))
        self.cli('XACK', 's', 'g', new_entry)
        self.assertEqual(self.retain()['after'], 0)

    def test_pending_tie_remains_exclusive(self):
        ms = self.fill(1)
        self.group('a', '$')
        self.group('z')
        self.cli('XREADGROUP', 'GROUP', 'z', 'c', 'COUNT', '1', 'STREAMS', 's', '>')
        result = self.retain(expected='a')
        self.assertEqual(result['boundary'], f'{ms}-1')
        self.assertFalse(result['boundary_inclusive'])
        self.assertEqual(result['trimmed'], 0)
        self.assertEqual(self.cli('XLEN', 's'), '1')

    def test_invalid_or_missing_groups_do_not_mutate(self):
        self.fill()
        self.group('g', '$')
        for expected, limit, mode in [('', '10000', 'apply'), ('g', '0', 'apply'), ('g', '10001', 'apply'), ('g', '10000', 'bad'), ('g,missing', '10000', 'apply')]:
            with self.assertRaises(subprocess.CalledProcessError):
                self.retain(expected, limit, mode)
            self.assertEqual(self.cli('XLEN', 's'), '500')
        self.cli('DEL', 's')
        self.cli('SET', 's', 'wrong')
        with self.assertRaises(subprocess.CalledProcessError):
            self.retain()

    def test_exact_integer_carry_and_maximum_id(self):
        self.cli('XADD', 's', f'1-{MAX}', 'f', 'v')
        self.cli('XADD', 's', '2-0', 'f', 'v')
        self.group('g', f'1-{MAX}')
        result = self.retain()
        self.assertEqual(result['boundary'], f'1-{MAX}')
        self.assertTrue(result['boundary_inclusive'])
        self.assertEqual(result['trimmed'], 1)
        self.cli('FLUSHALL')
        self.cli('XADD', 's', f'{MAX}-{MAX}', 'f', 'v')
        self.group('g', '$')
        result = self.retain()
        self.assertEqual(result['boundary'], f'{MAX}-{MAX}')
        self.assertTrue(result['boundary_inclusive'])
        self.assertEqual(result['trimmed'], 1)
        self.assertEqual(self.cli('XLEN', 's'), '0')

    def test_at_oom(self):
        self.fill(500)
        self.group('g', '$')
        self.cli('CONFIG', 'SET', 'maxmemory', '1')
        try:
            self.assertGreater(self.retain()['trimmed'], 0)
        finally:
            self.cli('CONFIG', 'SET', 'maxmemory', '0')

    def test_worker_drains_multiple_batches_promptly(self):
        ms = self.fill(5000)
        self.group('g', f'{ms}-4900')
        docker('exec', self.container, 'mkdir', '-p', '/retention')
        for name in ('run.sh', 'init.lua', 'retain.lua'):
            docker('cp', str(pathlib.Path(__file__).with_name(name)), f'{self.container}:/retention/{name}')
        docker('exec', '-d', '-e', 'REDIS_URL=redis://127.0.0.1:6379', '-e', 'STREAM=s',
               '-e', 'EXPECTED_GROUPS=g', '-e', 'BOOTSTRAP_GROUPS=', '-e', 'INTERVAL_SECONDS=30',
               '-e', 'TRIM_LIMIT=1000', self.container, 'sh', '-c', '/retention/run.sh & echo $! > /tmp/worker.pid; wait')
        try:
            deadline = time.monotonic() + 6
            length = 5000
            while time.monotonic() < deadline:
                length = int(self.cli('XLEN', 's'))
                if length <= 100:
                    break
                time.sleep(.1)
            self.assertEqual(length, 100)
            self.assertEqual(self.cli('XRANGE', 's', f'{ms}-4901', f'{ms}-4901').splitlines()[0], f'{ms}-4901')
        finally:
            docker('exec', self.container, 'sh', '-c', 'kill "$(cat /tmp/worker.pid)"')


if __name__ == '__main__':
    unittest.main()
