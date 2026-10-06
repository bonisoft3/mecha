import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { applyScopeSession, createRestHandler } from '../postgrest-js/src/rest-handler.ts'

const schema = `
  CREATE ROLE reader NOLOGIN;
  CREATE TABLE championship (id int PRIMARY KEY, show_country boolean);
  CREATE TABLE team (id int PRIMARY KEY, name text, country text, scope_id text NOT NULL);
  CREATE TABLE phase (id int PRIMARY KEY, name text, championship_id int REFERENCES championship);
  CREATE TABLE stage_group (id int PRIMARY KEY, name text, phase_id int REFERENCES phase);
  CREATE TABLE card (
    id int PRIMARY KEY, championship_id int REFERENCES championship,
    home_id int REFERENCES team, away_id int REFERENCES team,
    group_id int REFERENCES stage_group, played boolean, kickoff text,
    recent_rank int, scope_id text NOT NULL
  );
  CREATE TABLE paired (part int, id int, label text, PRIMARY KEY (part, id));
  CREATE TABLE composite (id int PRIMARY KEY, part int, pair_id int,
    FOREIGN KEY (part, pair_id) REFERENCES paired(part, id));
  INSERT INTO championship VALUES (10, true), (20, false);
  INSERT INTO team VALUES (1, 'Alpha United', 'BR', 'a'), (2, 'Secret FC', 'AR', 'b');
  INSERT INTO phase VALUES (1, 'First phase', 10), (2, 'Second phase', 20);
  INSERT INTO stage_group VALUES (1, 'First group', 1), (2, 'Second group', 2);
  INSERT INTO card VALUES
    (1, 10, 1, 2, 1, true, '12:00', 1, 'a'),
    (2, 10, 1, NULL, 2, true, NULL, 2, 'a'),
    (3, 20, 2, 1, NULL, false, '13:00', 3, 'a'),
    (4, 20, 2, 2, 2, true, '14:00', 4, 'b');
  INSERT INTO paired VALUES (1, 1, 'correct'), (2, 1, 'other');
  INSERT INTO composite VALUES (1, 1, 1);
  ALTER TABLE team ENABLE ROW LEVEL SECURITY;
  ALTER TABLE card ENABLE ROW LEVEL SECURITY;
  CREATE POLICY team_scope ON team USING (scope_id = ANY(string_to_array(current_setting('app.scopes', true), ',')));
  CREATE POLICY card_scope ON card USING (scope_id = ANY(string_to_array(current_setting('app.scopes', true), ',')));
  GRANT USAGE ON SCHEMA public TO reader;
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO reader;
`

// Browser reads used to split select at every comma and quietly discard a
// filter they did not recognize, so the page either refused embeddings or
// rendered rows its stated predicate excludes.
Deno.test('PostgREST browser reads preserve projection, filter, pagination and RLS semantics', async (test) => {
  const db = await PGlite.create()
  try {
    await db.exec(schema)
    const handler = createRestHandler(db, { role: 'reader', scopes: () => ['a'] })
    const request = (query: string, headers?: HeadersInit, table = 'card') =>
      handler(new Request(`http://localhost/${table}?${query}`, { headers }))
    const rows = async (query: string, table = 'card') => {
      const response = await request(query, undefined, table)
      const body = await response.json()
      assert.equal(response.status, 200, JSON.stringify(body))
      return body
    }

    await test.step('wildcard, scalar aliases and distinct foreign-key hints', async () => {
      const [row] = await rows('select=*,key:id,championship(show_country),home:home_id(country),away:away_id(country)&id=eq.1')
      assert.equal(row.id, 1)
      assert.equal(row.key, 1)
      assert.deepEqual(row.championship, { show_country: true })
      assert.deepEqual(row.home, { country: 'BR' })
      assert.equal(row.away, null)
      const [hinted] = await rows('select=home:team!card_home_id_fkey(name),away:team!away_id(name)&id=eq.1')
      assert.deepEqual(hinted, { home: { name: 'Alpha United' }, away: null })
    })

    await test.step('a missing left relation is null and keeps its parent', async () => {
      assert.deepEqual(await rows('select=id,away:away_id(country)&id=eq.2'), [{ id: 2, away: null }])
      assert.deepEqual(await rows('select=id,home:home_id(name)&home.name=eq.Nope&order=id.asc'), [
        { id: 1, home: null }, { id: 2, home: null }, { id: 3, home: null },
      ])
      const res = await request('select=id,home:home_id(name)&home.name=eq.Nope&limit=1', { Prefer: 'count=exact' })
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('Content-Range'), '0-0/3')
    })

    await test.step('nested inner joins apply related filters to parents and counts', async () => {
      const query = 'select=id,group:stage_group!inner(name,phase!inner(name,championship_id))&group.phase.championship_id=eq.10'
      assert.deepEqual(await rows(query), [{ id: 1, group: { name: 'First group', phase: { name: 'First phase', championship_id: 10 } } }])
      const res = await request(`${query}&limit=1`, { Prefer: 'count=exact' })
      assert.equal(res.headers.get('Content-Range'), '0-0/1')
      assert.deepEqual(await rows('select=id,home:home_id!inner(name)&order=id.asc'), [
        { id: 1, home: { name: 'Alpha United' } }, { id: 2, home: { name: 'Alpha United' } },
      ])
    })

    await test.step('composite foreign keys join every component', async () => {
      assert.deepEqual(await rows('select=id,paired(label)', 'composite'), [{ id: 1, paired: { label: 'correct' } }])
    })

    await test.step('not.is.null, booleans, comparisons, repeated filters and pagination', async () => {
      assert.deepEqual(await rows('select=id&played=is.true&recent_rank=gt.0&kickoff=not.is.null&order=recent_rank.asc&limit=20'), [{ id: 1 }])
      assert.deepEqual(await rows('select=id&id=gt.0&id=lt.3&order=id.desc&offset=1&limit=1'), [{ id: 1 }])
      assert.deepEqual(await rows('select=id&kickoff=is.null'), [{ id: 2 }])
      assert.deepEqual(await rows('select=id&played=not.is.true'), [{ id: 3 }])
      const res = await request('select=id&order=id.asc&offset=1&limit=1', { Prefer: 'count=exact' })
      assert.equal(res.headers.get('Content-Range'), '1-1/3')
      assert.deepEqual(await res.json(), [{ id: 2 }])
      const empty = await request('select=id&offset=20', { Prefer: 'count=exact' })
      assert.equal(empty.headers.get('Content-Range'), '*/3')
      assert.deepEqual(await empty.json(), [])
    })

    await test.step('PostgREST LIKE stars and quoted IN values bind as data', async () => {
      assert.deepEqual(await rows('select=id&name=like.*United*', 'team'), [{ id: 1 }])
      assert.deepEqual(await rows('select=id&name=ilike.*alpha*', 'team'), [{ id: 1 }])
      assert.deepEqual(await rows('select=id&name=in.("Alpha United","evil,comma")', 'team'), [{ id: 1 }])
      assert.deepEqual(await rows('select=id&name=eq.' + encodeURIComponent("' OR true --"), 'team'), [])
      assert.deepEqual(await rows('select=id&id=in.()'), [])
      assert.deepEqual(await rows('select=id&id=not.in.()&order=id.asc'), [{ id: 1 }, { id: 2 }, { id: 3 }])
    })

    await test.step('hostile or unsupported grammar fails before widening a read', async () => {
      for (const query of [
        'select=team(name)', 'select=missing(name)', 'select=*,', 'select=home:home_id(name',
        'select=id,id', 'select=id::text', 'select=home:home_id!bogus(name)',
        'select=home:home_id(name);DROP TABLE team', 'select=id&order=id.random',
        'select=id&order=id.asc.nullslast.garbage', 'select=id&id=bogus.1',
        'select=id&id=not.bogus.1', 'select=id&id=toString.1', 'select=id&id=1',
        'select=id&played=is.arbitrary', 'select=id&id=in.1,2',
        'select=id&id=in.(1,(SELECT 1))', 'select=id&or=(id.eq.1,id.eq.2)',
        'select=id&unselected.id=eq.1', 'select=id&limit=-1', 'select=id&offset=nope',
        'select=id&limit=9007199254740992', 'select=id&limit=1&limit=2',
        'select=id&select=scope_id', 'select=id&order=id.asc&order=id.desc',
        'select=id&id%22--=eq.1',
      ]) {
        const response = await request(query)
        assert.equal(response.status, 400, `${query}: ${await response.text()}`)
      }
      assert.deepEqual(await rows('select=id&order=id.asc'), [{ id: 1 }, { id: 2 }, { id: 3 }])
    })

    await test.step('concurrent subjects cannot see each other through relations or counts', async () => {
      const other = createRestHandler(db, { role: 'reader', scopes: () => ['b'] })
      const url = 'http://localhost/card?select=id,home:home_id(name)&order=id.asc'
      const [a, b] = await Promise.all([
        handler(new Request(url, { headers: { Prefer: 'count=exact' } })),
        other(new Request(url, { headers: { Prefer: 'count=exact' } })),
      ])
      assert.deepEqual(await a.json(), [
        { id: 1, home: { name: 'Alpha United' } }, { id: 2, home: { name: 'Alpha United' } }, { id: 3, home: null },
      ])
      assert.deepEqual(await b.json(), [{ id: 4, home: { name: 'Secret FC' } }])
      assert.equal(a.headers.get('Content-Range'), '0-2/3')
      assert.equal(b.headers.get('Content-Range'), '0-0/1')
      await applyScopeSession(db, ['b'], 'reader')
      await rows('select=id,home:home_id(name)')
      assert.deepEqual((await db.query('SELECT id FROM card')).rows, [{ id: 4 }])
      await db.exec('RESET ROLE')
    })

    await test.step('shared write predicates cannot silently widen an update or delete', async () => {
      const write = createRestHandler(db)
      const response = await write(new Request('http://localhost/championship', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 30, show_country: false }),
      }))
      assert.equal(response.status, 201)
      for (const method of ['PATCH', 'DELETE']) {
        const refused = await write(new Request('http://localhost/championship?id=unsupported.30', {
          method, ...(method === 'PATCH' ? { headers: { 'Content-Type': 'application/json' }, body: '{"show_country":true}' } : {}),
        }))
        assert.equal(refused.status, 400)
      }
      assert.deepEqual((await db.query('SELECT * FROM championship WHERE id = 30')).rows, [{ id: 30, show_country: false }])
      const patched = await write(new Request('http://localhost/championship?id=eq.30', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: '{"show_country":true}',
      }))
      assert.equal(patched.status, 200)
      assert.deepEqual(await patched.json(), [{ id: 30, show_country: true }])
      assert.equal((await write(new Request('http://localhost/championship?id=eq.30&id=not.is.null', { method: 'DELETE' }))).status, 204)
      assert.deepEqual((await db.query('SELECT id FROM championship ORDER BY id')).rows, [{ id: 10 }, { id: 20 }])
    })
  } finally {
    await db.close()
  }
})

// Views have no FK constraints, and a computed relation must run with the same
// subject as its source read even when its return type has independent RLS.
Deno.test('PostgREST browser view reads discover invoker to-one computed relationships', async (test) => {
  const db = await PGlite.create()
  try {
    await db.exec(schema)
    await db.exec(`
      INSERT INTO team VALUES (3, 'Another United', 'BR', 'a');
      CREATE TABLE game (id int PRIMARY KEY REFERENCES championship, slug text, scope_id text NOT NULL);
      INSERT INTO game VALUES (10, 'visible-game', 'a'), (20, 'hidden-game', 'b');
      ALTER TABLE game ENABLE ROW LEVEL SECURITY;
      CREATE POLICY game_scope ON game USING (scope_id = ANY(string_to_array(current_setting('app.scopes', true), ',')));
      CREATE VIEW team_campaign_point WITH (security_invoker=true) AS
        SELECT id, group_id, home_id AS team_id, championship_id AS game_id, scope_id FROM card;
      CREATE FUNCTION team(campaign team_campaign_point) RETURNS SETOF team
        LANGUAGE sql STABLE ROWS 1 SET search_path=public,pg_temp AS $$
          SELECT source.* FROM team source WHERE source.id=campaign.team_id
        $$;
      CREATE FUNCTION game(campaign team_campaign_point) RETURNS SETOF game
        LANGUAGE sql STABLE ROWS 1 SET search_path=public,pg_temp AS $$
          SELECT source.* FROM game source WHERE source.id=campaign.game_id
        $$;
      CREATE FUNCTION many(campaign team_campaign_point) RETURNS SETOF team
        LANGUAGE sql STABLE ROWS 100 AS $$ SELECT * FROM team $$;
      CREATE FUNCTION scalar(campaign team_campaign_point) RETURNS team
        LANGUAGE sql STABLE AS $$ SELECT * FROM team WHERE id=campaign.team_id $$;
      CREATE FUNCTION volatile_relation(campaign team_campaign_point) RETURNS SETOF team
        LANGUAGE sql VOLATILE ROWS 1 AS $$ SELECT * FROM team WHERE id=campaign.team_id $$;
      CREATE FUNCTION privileged(campaign team_campaign_point) RETURNS SETOF team
        LANGUAGE sql STABLE ROWS 1 SECURITY DEFINER AS $$ SELECT * FROM team WHERE id=campaign.team_id $$;
      CREATE FUNCTION default_arg(campaign team_campaign_point, extra int DEFAULT 1) RETURNS SETOF team
        LANGUAGE sql STABLE ROWS 1 AS $$ SELECT * FROM team WHERE id=campaign.team_id $$;
      CREATE FUNCTION wrong_source(source card) RETURNS SETOF team
        LANGUAGE sql STABLE ROWS 1 AS $$ SELECT * FROM team WHERE id=source.home_id $$;
      CREATE FUNCTION lying_many(campaign team_campaign_point) RETURNS SETOF team
        LANGUAGE sql STABLE ROWS 1 SET search_path=public,pg_temp AS $$ SELECT * FROM team $$;
      GRANT SELECT ON game, team_campaign_point TO reader;
      REVOKE ALL ON FUNCTION team(team_campaign_point), game(team_campaign_point) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION team(team_campaign_point), game(team_campaign_point) TO reader;
    `)
    const handler = createRestHandler(db, { role: 'reader', scopes: () => ['a'] })
    const request = (query: string, headers?: HeadersInit) => handler(new Request(`http://localhost/team_campaign_point?${query}`, { headers }))
    const rows = async (query: string) => {
      const response = await request(query)
      const body = await response.json()
      assert.equal(response.status, 200, JSON.stringify(body))
      return body
    }

    await test.step('the campaign projection retains source and related RLS', async () => {
      assert.deepEqual(await rows('select=*,team(name),game(slug)&group_id=eq.1&team_id=eq.1&limit=800'), [{
        id: 1, group_id: 1, team_id: 1, game_id: 10, scope_id: 'a',
        team: { name: 'Alpha United' }, game: { slug: 'visible-game' },
      }])
      assert.deepEqual(await rows('select=id,team(name),game(slug)&order=id.asc'), [
        { id: 1, team: { name: 'Alpha United' }, game: { slug: 'visible-game' } },
        { id: 2, team: { name: 'Alpha United' }, game: { slug: 'visible-game' } },
        { id: 3, team: null, game: null },
      ])
      const other = createRestHandler(db, { role: 'reader', scopes: () => ['b'] })
      const response = await other(new Request('http://localhost/team_campaign_point?select=id,team(name),game(slug)', { headers: { Prefer: 'count=exact' } }))
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), [{ id: 4, team: { name: 'Secret FC' }, game: { slug: 'hidden-game' } }])
      assert.equal(response.headers.get('Content-Range'), '0-0/1')
    })

    await test.step('left filters, inner filters, aliases, exact counts and pagination agree', async () => {
      const left = await request('select=id,team(name)&team.name=eq.Nope&order=id.asc&limit=1', { Prefer: 'count=exact' })
      assert.equal(left.status, 200)
      assert.deepEqual(await left.json(), [{ id: 1, team: null }])
      assert.equal(left.headers.get('Content-Range'), '0-0/3')
      const inner = await request('select=id,opponent:team!inner(name),game!inner(slug)&opponent.name=eq.Alpha%20United&game.slug=eq.visible-game&order=id.asc&offset=1&limit=1', { Prefer: 'count=exact' })
      assert.equal(inner.status, 200)
      assert.deepEqual(await inner.json(), [{ id: 2, opponent: { name: 'Alpha United' }, game: { slug: 'visible-game' } }])
      assert.equal(inner.headers.get('Content-Range'), '1-1/2')
      assert.deepEqual(await rows('select=id,game!inner(slug,championship!inner(show_country))&game.championship.show_country=is.true&order=id.asc'), [
        { id: 1, game: { slug: 'visible-game', championship: { show_country: true } } },
        { id: 2, game: { slug: 'visible-game', championship: { show_country: true } } },
      ])
      assert.deepEqual(await rows('select=id,team!inner(name)&team.name=eq.' + encodeURIComponent("' OR true --")), [])
      assert.deepEqual(await rows('select=id,team!inner(name)&team.name=eq.Secret%20FC'), [])
    })

    await test.step('unsupported signatures and hostile relation names fail closed', async () => {
      for (const query of [
        'select=many(name)', 'select=scalar(name)', 'select=volatile_relation(name)',
        'select=privileged(name)', 'select=default_arg(name)', 'select=wrong_source(name)',
        'select=team!missing(name)', 'select=team(name);DROP TABLE game',
        'select=id,team(name)&team.name=unsupported.Secret%20FC',
      ]) {
        const response = await request(query)
        assert.equal(response.status, 400, `${query}: ${await response.text()}`)
      }
      const ambiguous = await handler(new Request('http://localhost/card?select=team(name)'))
      assert.equal(ambiguous.status, 400)
      assert.match(await ambiguous.text(), /Ambiguous to-one relation/)
    })

    await test.step('an exact computed relation overrides the unhinted FK name and keeps explicit FK hints', async () => {
      await db.exec(`
        CREATE FUNCTION team(source card) RETURNS SETOF team
          LANGUAGE sql STABLE ROWS 1 AS $$ SELECT * FROM team WHERE id=source.home_id $$;
      `)
      const response = await handler(new Request('http://localhost/card?select=id,team(name),away:team!away_id(name)&id=eq.1'))
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), [{ id: 1, team: { name: 'Alpha United' }, away: null }])
    })

    await test.step('a source column named like its SQL alias cannot select an unchecked overload', async () => {
      await db.exec(`
        CREATE VIEW overload_source WITH (security_invoker=true) AS
          SELECT id, home_id AS team_id, 'wrong-overload'::text AS r0 FROM card;
        CREATE FUNCTION related(source overload_source) RETURNS SETOF team
          LANGUAGE sql STABLE ROWS 1 AS $$ SELECT * FROM team WHERE id=source.team_id $$;
        CREATE FUNCTION related(source text) RETURNS SETOF team
          LANGUAGE sql STABLE ROWS 1 SECURITY DEFINER AS $$ SELECT * FROM team WHERE id=2 $$;
        GRANT SELECT ON overload_source TO reader;
      `)
      const response = await handler(new Request('http://localhost/overload_source?select=id,related(name)&id=eq.1'))
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), [{ id: 1, related: { name: 'Alpha United' } }])
      const filtered = await handler(new Request('http://localhost/overload_source?select=id,related!inner(name)&related.name=eq.Secret%20FC', { headers: { Prefer: 'count=exact' } }))
      assert.equal(filtered.status, 200)
      assert.deepEqual(await filtered.json(), [])
      assert.equal(filtered.headers.get('Content-Range'), '*/0')
    })

    await test.step('ROWS 1 does not silently truncate a function that returns multiple rows', async () => {
      const response = await request('select=id,lying_many(name)&id=eq.1', { Prefer: 'count=exact' })
      assert.equal(response.status, 500)
      assert.match(await response.text(), /more than one row returned/)
    })

    await test.step('the caller needs permission to execute a computed relationship', async () => {
      await db.exec('REVOKE EXECUTE ON FUNCTION game(team_campaign_point) FROM reader')
      const response = await request('select=id,game(slug)&id=eq.1')
      assert.equal(response.status, 500)
      assert.match(await response.text(), /permission denied for function game/)
    })
  } finally {
    await db.close()
  }
})
