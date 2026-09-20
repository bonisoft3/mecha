-- The publication electric validates rather than builds: the cluster runs it
-- with ELECTRIC_MANUAL_TABLE_PUBLISHING, so the tables it may sync are stated
-- here, the way an app's emitted 007 states its own.
CREATE PUBLICATION electric_publication_default FOR TABLE "Hello", "GroupHello" WITH (publish_generated_columns = stored);
