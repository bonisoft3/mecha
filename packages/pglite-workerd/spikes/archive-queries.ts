export const queries = {
  players: `SELECT id,name,full_name,rating,latest_team_name FROM player_directory
    WHERE search_key LIKE '%' AND country_search_key LIKE '%' AND region_id LIKE '%' AND position_key LIKE '%'
    ORDER BY rating DESC NULLS LAST,name,id LIMIT 40`,
  flamengo: `SELECT id,team_id,measure_date,rating,offense,defense FROM team_rating
    WHERE team_id=(SELECT id FROM team WHERE slug='flamengo-rj')
    ORDER BY measure_date DESC,id LIMIT 100`,
  counts: `SELECT (SELECT count(*) FROM player) AS players,(SELECT count(*) FROM team) AS teams`,
}
