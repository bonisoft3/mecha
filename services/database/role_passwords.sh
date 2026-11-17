# Sourced by docker-entrypoint.sh at initdb, after the roles migration made
# electric and authenticator LOGIN roles. The passwords are the deployment's,
# as on Kubernetes, where the operator sets them from secrets: a schema that
# set them would overwrite those secrets whenever it ran.
ownership=$(docker_process_sql -Atqc "SELECT coalesce(nullif(current_setting('mecha.roles', true), ''), 'framework')")
case "$ownership" in
  external) return 0 ;;
  framework) ;;
  *) echo "mecha.roles must be framework or external, got $ownership" >&2; return 1 ;;
esac
: "${ELECTRIC_PASSWORD:?ELECTRIC_PASSWORD is required: the password of the electric role, which the DATABASE_URL of electric carries}"
: "${AUTHENTICATOR_PASSWORD:?AUTHENTICATOR_PASSWORD is required: the password of the authenticator role, which PostgREST logs in as}"
docker_process_sql --set=electric="$ELECTRIC_PASSWORD" --set=authenticator="$AUTHENTICATOR_PASSWORD" <<'SQL'
ALTER ROLE electric PASSWORD :'electric';
ALTER ROLE authenticator PASSWORD :'authenticator';
SQL
