import json
from pathlib import Path
import re
import subprocess
import tempfile
import time
import unittest
import uuid


HERE = Path(__file__).resolve().parent
CLUSTER = (HERE.parents[1] / 'cluster.cue').read_text()
REDIS = re.search(r'#RedisImage: "(redis:[^"]+)"', CLUSTER)[1]
CONNECT = re.search(r'from: name: "(redpandadata/connect:[^"]+)"', CLUSTER)[1]


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True).strip()


class NativeRetentionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.network = 'native-retention-' + uuid.uuid4().hex[:10]
        docker('network', 'create', cls.network)
        cls.addClassCleanup(docker, 'network', 'rm', cls.network)
        cls.server = docker('run', '-d', '--network', cls.network, '--network-alias', 'redis', REDIS)
        cls.addClassCleanup(docker, 'rm', '-fv', cls.server)
        for _ in range(100):
            ping = subprocess.run(['docker', 'exec', cls.server, 'redis-cli', 'PING'],
                                  capture_output=True, text=True)
            if ping.returncode == 0 and ping.stdout.strip() == 'PONG':
                return
            time.sleep(.1)
        raise RuntimeError('Redis did not become ready')

    def redis(self, *args):
        return json.loads(docker('exec', self.server, 'redis-cli', '-e', '--json', *map(str, args)))

    def setUp(self):
        self.redis('FLUSHALL')

    def seed(self):
        self.redis('EVAL', "for i=1,12000 do redis.call('XADD',KEYS[1],i..'-0','data','payload') end return 1", 1, 'cdc-events')

    def group(self, name, acknowledged=True):
        self.redis('XGROUP', 'CREATE', 'cdc-events', name, '0', 'MKSTREAM')
        if acknowledged:
            rows = self.redis('XREADGROUP', 'GROUP', name, 'reader', 'COUNT', 12000, 'STREAMS', 'cdc-events', '>')
            if rows:
                ids = [row[0] for row in rows['cdc-events']]
                for offset in range(0, len(ids), 1000):
                    self.redis('XACK', 'cdc-events', name, *ids[offset:offset + 1000])

    def trim(self, expected, *, wake=False, success=True):
        with tempfile.TemporaryDirectory() as temporary:
            config = Path(temporary) / 'pipeline.json'
            config.write_text(json.dumps({
                'input': {'generate': {'count': 1, 'interval': '', 'mapping':
                    'root = {"wake":"start"}' if wake else 'root = {"data":"payload"}\nmeta redis_stream = "12000-0"'}},
                'pipeline': {'processors': [{'resource': 'cdc_stream_trim'}]},
                'output': {'stdout': {'codec': 'lines'}},
            }))
            container = docker('create', '--network', self.network,
                               '-e', 'REDIS_URL=redis://redis:6379', '-e', 'CDC_GROUPS=' + json.dumps(expected),
                               '--entrypoint', '/redpanda-connect', CONNECT,
                               '-r', '/resources.yaml', '-c', '/pipeline.json')
            try:
                docker('cp', str(HERE / 'cdc-trace.yaml'), container + ':/resources.yaml')
                docker('cp', str(config), container + ':/pipeline.json')
                run = subprocess.run(['docker', 'start', '-a', container], capture_output=True, text=True, timeout=30)
                code = int(docker('inspect', '--format', '{{.State.ExitCode}}', container))
                if success:
                    self.assertEqual(code, 0, run.stdout + run.stderr)
                    self.assertIn('"wake":"start"' if wake else '"data":"payload"', run.stdout)
                else:
                    self.assertNotEqual(code, 0, run.stdout + run.stderr)
            finally:
                docker('rm', '-fv', container)

    def test_missing_reader_blocks_trimming_until_it_registers_and_acknowledges(self):
        self.seed()
        self.group('active')
        self.trim(['active', 'late'])
        self.assertEqual(self.redis('XLEN', 'cdc-events'), 12000)
        self.group('late', acknowledged=False)
        self.trim(['active', 'late'])
        self.assertEqual(self.redis('XLEN', 'cdc-events'), 12000)
        self.redis('XREADGROUP', 'GROUP', 'late', 'reader', 'COUNT', 12000, 'STREAMS', 'cdc-events', '>')
        self.trim(['active', 'late'])
        self.assertEqual(self.redis('XLEN', 'cdc-events'), 12000)
        for offset in range(0, 12000, 1000):
            self.redis('XACK', 'cdc-events', 'late', *[f'{i}-0' for i in range(offset+1, offset+1001)])
        self.trim(['active', 'late'])
        self.assertLess(self.redis('XLEN', 'cdc-events'), 12000)
        self.assertGreaterEqual(self.redis('XLEN', 'cdc-events'), 10000)

    def test_unknown_group_pending_and_unread_entries_survive(self):
        self.seed()
        self.group('active')
        self.group('unknown', acknowledged=False)
        self.redis('XREADGROUP', 'GROUP', 'unknown', 'reader', 'COUNT', 1, 'STREAMS', 'cdc-events', '>')
        self.trim(['active'])
        self.assertEqual(self.redis('XPENDING', 'cdc-events', 'unknown')[0], 1)
        self.assertEqual(self.redis('XRANGE', 'cdc-events', '1-0', '1-0')[0][0], '1-0')
        self.assertEqual(self.redis('XLEN', 'cdc-events'), 12000)
        self.redis('XGROUP', 'DESTROY', 'cdc-events', 'unknown')
        self.trim(['active'])
        self.assertLess(self.redis('XLEN', 'cdc-events'), 12000)

    def test_startup_wake_needs_no_stream(self):
        self.trim(['active'], wake=True)
        self.assertEqual(self.redis('EXISTS', 'cdc-events'), 0)

    def test_generated_groups_match_launched_readers(self):
        app = HERE.parents[3] / 'apps/golaberto'
        profile = json.loads(subprocess.check_output(
            ['docker', 'compose', '-f', str(app / '.bayt/compose.launch.closure.yaml'),
             'config', '--format', 'json'], text=True))
        transform = profile['services']['golaberto-transform']
        dockerfile = (app / transform['build']['dockerfile']).read_text()
        command = json.loads(re.search(r'^CMD (.+)$', dockerfile, re.MULTILINE)[1])
        groups = set()
        for source, target in re.findall(r'^COPY (docker/[^ ]+) (/pipelines/[^ ]+)$', dockerfile, re.MULTILINE):
            if target in command:
                groups.update(re.findall(r'^ +consumer_group: ([-a-z0-9]+)', (app / source).read_text(), re.MULTILINE))
        if '/compute-events.yaml' in command:
            groups.add(transform['environment']['COMPUTE_GROUP'])
        self.assertEqual(set(json.loads(transform['environment']['CDC_GROUPS'])), groups)
        self.assertNotIn('golaberto-compute', groups)
        self.assertIn(REDIS, (app / '.bayt/Dockerfile.redis').read_text())

    def test_generated_apps_share_the_redis_pin_and_trimming_manifest(self):
        for redisfile in (HERE.parents[3] / 'apps').glob('*/.bayt/Dockerfile.redis'):
            with self.subTest(app=redisfile.parent.parent.name):
                self.assertIn(REDIS, redisfile.read_text())
                transform = redisfile.with_name('bayt.transform.json')
                if transform.exists():
                    spec = json.loads(transform.read_text())
                    self.assertIsInstance(json.loads(spec['compose']['environment']['CDC_GROUPS']), list)
                    self.assertIn('cdc_stream_trim', redisfile.with_name('Dockerfile.transform').read_text())

    def test_empty_manifest_fails_instead_of_trimming(self):
        self.seed()
        self.trim([], success=False)
        self.assertEqual(self.redis("XLEN", "cdc-events"), 12000)

    def test_trim_can_reclaim_entries_at_the_memory_limit(self):
        self.seed()
        self.group('active')
        self.redis('CONFIG', 'SET', 'maxmemory', 1)
        try:
            self.trim(['active'])
            self.assertLess(self.redis('XLEN', 'cdc-events'), 12000)
        finally:
            self.redis('CONFIG', 'SET', 'maxmemory', 0)

    def test_release_binaries_run_with_postgres_dependencies(self):
        postgres = re.search(r'#PostgresImage: "([^"]+)"', CLUSTER)[1]
        container = docker('create', '--entrypoint', 'sh', postgres, '-c',
                           'redis-server --version && redis-cli --version')
        try:
            with tempfile.TemporaryDirectory() as temporary:
                for binary in ('redis-server', 'redis-cli'):
                    path = str(Path(temporary) / binary)
                    docker('cp', self.server + ':/usr/local/bin/' + binary, path)
                    docker('cp', path, container + ':/usr/local/bin/' + binary)
            output = docker('start', '-a', container)
            self.assertEqual(docker('inspect', '--format', '{{.State.ExitCode}}', container), '0', output)
            self.assertIn('v=8.2.11', output)
            self.assertIn('redis-cli 8.2.11', output)
        finally:
            docker('rm', '-fv', container)

    def test_command_failure_stops_processing(self):
        self.trim(['active'], success=False)
