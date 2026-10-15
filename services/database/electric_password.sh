# Sourced by docker-entrypoint.sh at initdb, after the roles migration made
# electric a LOGIN role. The password is the deployment's, as on Kubernetes,
# where the operator sets it from a secret: a schema that set it would overwrite
# that secret whenever it ran.
: "${ELECTRIC_PASSWORD:?ELECTRIC_PASSWORD is required: the password of the electric role, which the DATABASE_URL of electric carries}"
docker_process_sql --set=password="$ELECTRIC_PASSWORD" <<'SQL'
ALTER ROLE electric PASSWORD :'password';
SQL
