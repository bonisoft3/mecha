from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import subprocess
import tempfile
import threading
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

    def trim(self, expected, *, wake=False, success=True, consumer='', retry=(), count=1, after=(), budget=None, data='payload', stream_id='12000-0', processors=None):
        with tempfile.TemporaryDirectory() as temporary:
            config = Path(temporary) / 'pipeline.json'
            config.write_text(json.dumps({
                'input': {'generate': {'count': count, 'interval': '', 'mapping':
                    ('root = {"wake":"start"}' + (f'\nmeta cdc_consumer = {json.dumps(consumer)}' if consumer else '')) if wake
                    else 'root = {"data":%s}\nmeta redis_stream = %s\nmeta cdc_consumer = %s' % (json.dumps(data), json.dumps(stream_id), json.dumps(consumer))}},
                'pipeline': {'threads': 1, 'processors': [{'resource': 'cdc_stream_trim'}, *after] if processors is None else processors},
                'output': {'stdout': {'codec': 'lines'}},
            }))
            env_args = [
                '-e', 'REDIS_URL=redis://redis:6379',
                '-e', 'CDC_GROUPS=' + json.dumps(expected),
                '-e', 'CDC_RETRY_GROUPS=' + json.dumps(list(retry)),
            ]
            if budget is not None:
                env_args.extend(['-e', f'CDC_GROUP_BUDGET={budget}'])
            container = docker('create', '--network', self.network,
                               *env_args,
                               '--entrypoint', '/redpanda-connect', CONNECT,
                               '-r', '/resources.yaml', '-c', '/pipeline.json')
            try:
                docker('cp', str(HERE / 'cdc-trace.yaml'), container + ':/resources.yaml')
                docker('cp', str(config), container + ':/pipeline.json')
                run = subprocess.run(['docker', 'start', '-a', container], capture_output=True, text=True, timeout=30)
                code = int(docker('inspect', '--format', '{{.State.ExitCode}}', container))
                if success:
                    self.assertEqual(code, 0, run.stdout + run.stderr)
                    if processors is None:
                        self.assertIn('"wake":"start"' if wake else f'"data":{json.dumps(data)}', run.stdout)
                else:
                    self.assertNotEqual(code, 0, run.stdout + run.stderr)
                return run.stdout + run.stderr
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

    # A record that kills its reader leaves no copy in memory to hand off: only
    # its delivery count grows, one restart at a time, and the reader would
    # crash on it forever.
    def test_crash_loop_moves_to_its_groups_retry_stream_past_the_delivery_limit(self):
        for i in (1, 2, 3):
            self.redis('XADD', 'cdc-events', f'{i}-0', 'data', f'payload-{i}')
        self.group('crashy', acknowledged=False)
        self.redis('XREADGROUP', 'GROUP', 'crashy', 'reader', 'COUNT', 3, 'STREAMS', 'cdc-events', '>')
        for _ in range(6):
            self.redis('XCLAIM', 'cdc-events', 'crashy', 'reader', 0, '1-0')
        self.trim(['crashy'], consumer='crashy')
        self.assertEqual(self.redis('XLEN', 'crashy-retry'), 0)
        self.trim(['crashy'], consumer='crashy', retry=['crashy'])
        self.assertEqual(self.redis('XRANGE', 'crashy-retry', '-', '+')[0][1], ['data', 'payload-1'])
        self.assertEqual(self.redis('XLEN', 'crashy-retry'), 1)
        self.assertEqual(self.redis('XPENDING', 'cdc-events', 'crashy')[0], 2)

    # A reader that keeps reading after Redis lost its entries, or after its
    # group was retired, would never see what fell between: it has to stop so
    # its restart rebuilds.
    def test_a_reader_stops_when_its_groups_epoch_changes(self):
        self.seed()
        self.group('active')
        self.trim(['active'], consumer='active', count=3)
        forget = {'redis_script': {'url': 'redis://redis:6379', 'keys_mapping': 'root = ["cdc-epoch:active"]',
                                   'args_mapping': 'root = []', 'script': "return redis.call('DEL', KEYS[1])"}}
        self.assertIn('restarting to rebuild', self.trim(['active'], consumer='active', count=2, after=[forget], success=False))

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
            self.assertIn('v=8.4.8', output)
            self.assertIn('redis-cli 8.4.8', output)
        finally:
            docker('rm', '-fv', container)

    def test_command_failure_stops_processing(self):
        self.trim(['active'], success=False)

    def test_stalled_group_past_budget_is_retired_and_trimming_continues(self):
        self.seed()
        self.group('active')
        self.group('stalled', acknowledged=False)
        # 3000 pending + 9000 lag = 12000 > budget 5000.
        self.redis('XREADGROUP', 'GROUP', 'stalled', 'reader', 'COUNT', 3000, 'STREAMS', 'cdc-events', '>')
        self.redis('SET', 'cdc-epoch:stalled', '100.0')
        # Undeclared group past budget is left untouched.
        self.group('undeclared', acknowledged=False)
        self.trim(['active', 'stalled'], budget=5000)
        groups = self.redis('XINFO', 'GROUPS', 'cdc-events')
        names = {g['name'] for g in groups}
        self.assertNotIn('stalled', names)
        self.assertIn('undeclared', names)
        self.assertEqual(self.redis('EXISTS', 'cdc-epoch:stalled'), 0)
        self.assertEqual(self.redis('EXISTS', 'cdc-retired:stalled'), 1)
        # Destroy undeclared so ACKED trimming can reclaim below 12000.
        self.redis('XGROUP', 'DESTROY', 'cdc-events', 'undeclared')
        self.trim(['active', 'stalled'], budget=5000)
        self.assertLess(self.redis('XLEN', 'cdc-events'), 12000)
        # Once the reader restarts and re-registers its group, the retired marker clears.
        self.redis('XGROUP', 'CREATE', 'cdc-events', 'stalled', '$', 'MKSTREAM')
        self.trim(['active', 'stalled'], budget=5000)
        self.assertEqual(self.redis('EXISTS', 'cdc-retired:stalled'), 0)

    def test_retired_reader_startup_wake_advances_group_to_stream_tail(self):
        # Regression: start_from_oldest creates retired groups at offset 0 if a
        # retained backlog remains past budget; startup wake advances them to $.
        self.seed()
        self.group('active')
        self.group('stalled', acknowledged=False)
        self.group('undeclared', acknowledged=False)
        self.trim(['active', 'stalled'], budget=5000)
        self.assertEqual(self.redis('EXISTS', 'cdc-retired:stalled'), 1)

        self.trim(['active', 'stalled'], wake=True, consumer='stalled', budget=5000)
        self.assertEqual(self.redis('EXISTS', 'cdc-retired:stalled'), 0)
        self.assertEqual(self.redis('XLEN', 'cdc-events'), 12000)
        stalled = next(g for g in self.redis('XINFO', 'GROUPS', 'cdc-events') if g['name'] == 'stalled')
        self.assertEqual(stalled['lag'], 0)
        self.trim(['active', 'stalled'], budget=5000)
        self.assertIn('stalled', {g['name'] for g in self.redis('XINFO', 'GROUPS', 'cdc-events')})

    def test_retired_reader_reconnecting_at_zero_advances_to_tail_and_stops_once(self):
        self.seed()
        self.group('active')
        self.group('stalled', acknowledged=False)
        self.group('undeclared', acknowledged=False)
        self.trim(['active', 'stalled'], budget=5000)
        self.assertEqual(self.redis('EXISTS', 'cdc-retired:stalled'), 1)

        # Simulate start_from_oldest recreating the destroyed group at offset 0 while
        # the stream is still above budget due to an undeclared reader.
        self.redis('XGROUP', 'CREATE', 'cdc-events', 'stalled', '0', 'MKSTREAM')
        self.redis('XREADGROUP', 'GROUP', 'stalled', 'reader', 'COUNT', 1, 'STREAMS', 'cdc-events', '>')
        out = self.trim(['active', 'stalled'], consumer='stalled', budget=5000, success=False)
        self.assertIn('restarting to rebuild', out)
        self.assertEqual(self.redis('EXISTS', 'cdc-retired:stalled'), 0)
        stalled = next(g for g in self.redis('XINFO', 'GROUPS', 'cdc-events') if g['name'] == 'stalled')
        self.assertEqual((stalled['pending'], stalled['lag']), (0, 0))
        self.trim(['active', 'stalled'], consumer='stalled', budget=5000)
        self.assertIn('stalled', {g['name'] for g in self.redis('XINFO', 'GROUPS', 'cdc-events')})

    def test_slot_reset_stops_reader_clears_epochs_and_does_not_loop(self):
        self.seed()
        self.group('g1')
        self.group('g2')
        self.redis('SET', 'cdc-epoch:g1', '10.1')
        self.redis('SET', 'cdc-epoch:g2', '10.2')
        reset_payload = json.dumps({'__table': 'slot_reset'})
        reset_id = self.redis('XADD', 'cdc-events', '*', 'data', reset_payload)
        self.redis('XREADGROUP', 'GROUP', 'g1', 'reader', 'COUNT', 1, 'STREAMS', 'cdc-events', '>')
        self.redis('XREADGROUP', 'GROUP', 'g2', 'reader', 'COUNT', 1, 'STREAMS', 'cdc-events', '>')
        out = self.trim(['g1', 'g2'], consumer='g1', data=reset_payload, stream_id=reset_id, success=False)
        self.assertIn('the bus slot was lost for g1: restarting to rebuild', out)
        self.assertEqual(self.redis('XPENDING', 'cdc-events', 'g1')[0], 0)
        self.assertEqual(self.redis('EXISTS', 'cdc-epoch:g1'), 0)
        self.assertEqual(self.redis('EXISTS', 'cdc-epoch:g2'), 0)
        # A second reader seeing the same reset_id drops the marker cleanly without looping.
        out2 = self.trim(
            ['g1', 'g2'],
            consumer='g2',
            data=reset_payload,
            stream_id=reset_id,
            processors=[{'resource': 'cdc_stream_trim'}, {'resource': 'cdc_trace_join'}],
        )
        self.assertNotIn('slot_reset', out2)

    def test_pipeline_start_sweeps_source_with_one_aggregate_read(self):
        rows = [
            {'id': '11111111-1111-1111-1111-111111111111', 'user_id': 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'article_id': 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'created_at': '2026-11-24T00:00:00Z', 'deleted_at': None, 'txid': 42},
            {'id': '22222222-2222-2222-2222-222222222222', 'user_id': 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'article_id': 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'created_at': '2026-11-24T00:00:01Z', 'deleted_at': None, 'txid': 43},
        ]
        requests_log = []
        upserts = []
        done = threading.Event()
        lock = threading.Lock()

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                pass

            def do_GET(self):
                with lock:
                    requests_log.append(('GET', self.path))
                body = json.dumps(rows).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                length = int(self.headers.get('Content-Length', '0'))
                payload = json.loads(self.rfile.read(length))
                with lock:
                    requests_log.append(('POST', self.path))
                    upserts.extend(payload if isinstance(payload, list) else [payload])
                    if len(upserts) >= 2:
                        done.set()
                self.send_response(201)
                self.send_header('Content-Length', '0')
                self.end_headers()

        container, server = self._run_sweep_pipeline(Handler)
        try:
            docker('start', container)
            self.assertTrue(done.wait(timeout=20), f'sweep did not post 2 rows: {requests_log} {upserts}')
        finally:
            subprocess.run(['docker', 'rm', '-fv', container], capture_output=True)
            server.shutdown()
            server.server_close()

        self.assertEqual([r for r in requests_log if r[0] == 'GET'], [
            ('GET', '/favorite'),
            ('GET', '/favorite?select=user_id,article_id,txid,deleted_at'),
        ])
        self.assertEqual(len(upserts), 2)
        for row in upserts:
            self.assertEqual(row['mine_counted'], 1)
            self.assertEqual(row['total_at_read'], 2)

    def _run_sweep_pipeline(self, handler_cls, pipeline_rel='apps/realworld/docker/realworld-favorite-count.yaml', group='realworld-favorite-count'):
        server = ThreadingHTTPServer(('0.0.0.0', 0), handler_cls)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        pipeline = HERE.parents[3] / pipeline_rel
        container = docker(
            'create', '--network', self.network,
            '--add-host=host.docker.internal:host-gateway',
            '-e', f'CRUD_URL=http://host.docker.internal:{port}',
            '-e', 'REDIS_URL=redis://redis:6379',
            '-e', 'SERVICE_JWT=test',
            '-e', 'CDC_GROUPS=' + json.dumps([group]),
            '--entrypoint', '/redpanda-connect', CONNECT,
            'streams', '--no-api', '-r', '/resources.yaml', '/pipeline.yaml',
        )
        try:
            docker('cp', str(HERE / 'cdc-trace.yaml'), container + ':/resources.yaml')
            docker('cp', str(pipeline), container + ':/pipeline.yaml')
            return container, server
        except Exception:
            subprocess.run(['docker', 'rm', '-fv', container], capture_output=True)
            server.shutdown()
            server.server_close()
            raise

    def test_pipeline_start_sweep_finishes_before_live_stream_writes(self):
        # Regression: startup sweep must complete all initial upserts before live
        # CDC events run, so slow sweep writes cannot overwrite newer live state.
        sweep_rows = [
            {'id': '11111111-1111-1111-1111-111111111111', 'user_id': 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'article_id': 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'created_at': '2026-11-24T00:00:00Z', 'deleted_at': None, 'txid': 42},
            {'id': '22222222-2222-2222-2222-222222222222', 'user_id': 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'article_id': 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'created_at': '2026-11-24T00:00:01Z', 'deleted_at': None, 'txid': 43},
        ]
        live_rows = sweep_rows + [
            {'id': '33333333-3333-3333-3333-333333333333', 'user_id': 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'article_id': 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'created_at': '2026-11-24T00:00:02Z', 'deleted_at': None, 'txid': 44},
        ]
        live_row = live_rows[2] | {'created_at': '2026-11-24 00:00:02+00', '__table': 'favorite'}
        self.redis('XADD', 'cdc-events', '*', 'data', json.dumps({'data': json.dumps(live_row)}))
        events = []
        sink = {}
        done = threading.Event()
        lock = threading.Lock()

        class OrderedHandler(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                pass

            def do_GET(self):
                with lock:
                    events.append(('GET', self.path))
                    body = json.dumps(sweep_rows if len(events) <= 2 else live_rows).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                length = int(self.headers.get('Content-Length', '0'))
                payload = json.loads(self.rfile.read(length))
                rows = payload if isinstance(payload, list) else [payload]
                is_sweep = len(rows) > 1
                if is_sweep:
                    time.sleep(0.3)
                with lock:
                    events.append(('POST', 'sweep' if is_sweep else 'live', [r['total_at_read'] for r in rows]))
                    for row in rows:
                        sink[row['id']] = row
                    if not is_sweep:
                        done.set()
                self.send_response(201)
                self.send_header('Content-Length', '0')
                self.end_headers()

        container, server = self._run_sweep_pipeline(OrderedHandler)
        try:
            docker('start', container)
            self.assertTrue(done.wait(timeout=20), f'live write never arrived: {events}')
        finally:
            subprocess.run(['docker', 'rm', '-fv', container], capture_output=True)
            server.shutdown()
            server.server_close()

        self.assertEqual(events, [
            ('GET', '/favorite'),
            ('GET', '/favorite?select=user_id,article_id,txid,deleted_at'),
            ('POST', 'sweep', [2, 2]),
            ('GET', '/favorite?select=user_id,article_id,txid,deleted_at'),
            ('POST', 'live', [3]),
        ])
        self.assertEqual(sink['dddddddd-dddd-dddd-dddd-dddddddddddd:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']['total_at_read'], 3)

    def test_pipeline_start_sweep_deduplicates_output_without_quadratic_writes(self):
        # Regression: sweeping N rows of a full-table/multi-row sink must emit one
        # deduplicated upsert per key rather than N*M quadratic writes.
        fav_rows = [
            {'id': '1', 'user_id': 'u1', 'article_id': 'a1', 'created_at': '2026-11-24T00:00:00Z', 'deleted_at': None},
            {'id': '2', 'user_id': 'u2', 'article_id': 'a1', 'created_at': '2026-11-24T00:00:01Z', 'deleted_at': None},
            {'id': '3', 'user_id': 'u3', 'article_id': 'a1', 'created_at': '2026-11-24T00:00:02Z', 'deleted_at': '2026-11-24T00:00:03Z'},
        ]
        posts = []
        done = threading.Event()
        lock = threading.Lock()

        class IndexHandler(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                pass

            def do_GET(self):
                body = json.dumps(fav_rows).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                length = int(self.headers.get('Content-Length', '0'))
                payload = json.loads(self.rfile.read(length))
                with lock:
                    posts.append(payload if isinstance(payload, list) else [payload])
                    done.set()
                self.send_response(201)
                self.send_header('Content-Length', '0')
                self.end_headers()

        container, server = self._run_sweep_pipeline(
            IndexHandler,
            pipeline_rel='apps/realworld/docker/realworld-favorite-index.yaml',
            group='realworld-favorite-index',
        )
        try:
            docker('start', container)
            self.assertTrue(done.wait(timeout=20), f'index sweep never posted: {posts}')
            time.sleep(0.5)
        finally:
            subprocess.run(['docker', 'rm', '-fv', container], capture_output=True)
            server.shutdown()
            server.server_close()

        self.assertEqual(len(posts), 1)
        by_id = {row['id']: row for row in posts[0]}
        self.assertEqual(len(posts[0]), 3)
        self.assertEqual({k: v['active'] for k, v in by_id.items()}, {
            'u1:a1': True,
            'u2:a1': True,
            'u3:a1': False,
        })

    def test_pipeline_start_sweep_crashes_on_fetch_failure(self):
        # Regression: a failed startup sweep must crash the pipeline rather than
        # swallowing the error and serving an incomplete materialized view.
        class FailHandler(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                pass

            def do_GET(self):
                self.send_response(400)
                self.send_header('Content-Length', '0')
                self.end_headers()

        container, server = self._run_sweep_pipeline(FailHandler)
        try:
            run = subprocess.run(['docker', 'start', '-a', container], capture_output=True, text=True, timeout=30)
            code = int(docker('inspect', '--format', '{{.State.ExitCode}}', container))
            out = run.stdout + run.stderr
            self.assertNotEqual(code, 0, out)
            self.assertIn('startup sweep failed', out)
        finally:
            subprocess.run(['docker', 'rm', '-fv', container], capture_output=True)
            server.shutdown()
            server.server_close()

    def test_pipeline_start_sweep_handles_empty_source_without_crashing(self):
        fetched = threading.Event()

        class EmptyHandler(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                pass

            def do_GET(self):
                fetched.set()
                body = b'[]'
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        container, server = self._run_sweep_pipeline(EmptyHandler)
        try:
            docker('start', container)
            self.assertTrue(fetched.wait(timeout=20), 'sweep did not query source')
            time.sleep(1.5)
            running = docker('inspect', '--format', '{{.State.Running}}', container)
            self.assertEqual(running, 'true', docker('logs', container))
        finally:
            subprocess.run(['docker', 'rm', '-fv', container], capture_output=True)
            server.shutdown()
            server.server_close()

    def test_durable_retry_crashes_when_redrive_fails(self):
        # Regression: redrive errors at startup must crash the stream instead of
        # logging an empty INFO report and exiting zero.
        self.redis('SET', 'g1-dead', 'wrongtype')
        container = docker(
            'create', '--network', self.network,
            '-e', 'REDIS_URL=redis://redis:6379',
            '-e', 'CDC_RETRY_GROUPS=["g1"]',
            '--entrypoint', '/redpanda-connect', CONNECT,
            'streams', '--no-api', '/pipeline.yaml',
        )
        try:
            docker('cp', str(HERE / 'durable-retry.yaml'), container + ':/pipeline.yaml')
            run = subprocess.run(['docker', 'start', '-a', container], capture_output=True, text=True, timeout=30)
            code = int(docker('inspect', '--format', '{{.State.ExitCode}}', container))
            out = run.stdout + run.stderr
            self.assertNotEqual(code, 0, out)
            self.assertIn('durable retry redrive failed', out)
        finally:
            subprocess.run(['docker', 'rm', '-fv', container], capture_output=True)
