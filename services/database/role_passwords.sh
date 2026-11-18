# Sourced by docker-entrypoint.sh at initdb, after the roles migration made
# electric and authenticator LOGIN roles. The passwords are the deployment's,
# as on Kubernetes, where the operator sets them from secrets: a schema that
# set them would overwrite those secrets whenever it ran.
: "${ELECTRIC_PASSWORD:?ELECTRIC_PASSWORD is required: the password of the electric role, which the DATABASE_URL of electric carries}"
: "${AUTHENTICATOR_PASSWORD:?AUTHENTICATOR_PASSWORD is required: the password of the authenticator role, which PostgREST logs in as}"
docker_process_sql --set=electric="$ELECTRIC_PASSWORD" --set=authenticator="$AUTHENTICATOR_PASSWORD" <<'SQL'
ALTER ROLE electric PASSWORD :'electric';
ALTER ROLE authenticator PASSWORD :'authenticator';
SQL
