-- The publication electric validates rather than builds: the cluster runs it
-- with ELECTRIC_MANUAL_TABLE_PUBLISHING, so the tables it may sync are stated
-- here.
CREATE PUBLICATION electric_publication_default FOR TABLE "Hello", "GroupHello" WITH (publish_generated_columns = stored);
-- Electric refuses a shape over a table whose updates do not carry the whole
-- old row.
ALTER TABLE "Hello" REPLICA IDENTITY FULL;
ALTER TABLE "GroupHello" REPLICA IDENTITY FULL;
