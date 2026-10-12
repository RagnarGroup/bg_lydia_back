-- LYD-79: ultimo mensaje de cada conversacion guardado en el propio Chat, para
-- que la lista del inbox (GET /crm/conversations) no tenga que recorrer toda
-- la tabla Message en cada poll. Message no tiene FK a Chat: se cruzan por
-- instanceId + key->>'remoteJid'.
--
-- Lo mantienen triggers de Postgres (no el codigo) porque los mensajes se
-- insertan desde muchos lugares (Cloud API, Baileys, Messenger/Instagram,
-- envios, bots) y asi ninguno puede olvidarse de actualizarlo. Los triggers
-- no tocan Chat.updatedAt (lo pone Prisma, no la base).
--
-- Prisma no sabe modelar indices por expresion ni triggers: si un
-- `prisma migrate dev` futuro propone un DROP INDEX
-- "Message_instanceId_remoteJid_timestamp_idx", sacarlo a mano de la
-- migracion generada.

ALTER TABLE "Chat" ADD COLUMN "lastMessageAt" INTEGER;
ALTER TABLE "Chat" ADD COLUMN "lastMessageId" TEXT;

-- Mensaje mas nuevo de un chat en una sola lectura de indice (lo usan los
-- triggers y el relleno inicial).
CREATE INDEX IF NOT EXISTS "Message_instanceId_remoteJid_timestamp_idx"
  ON "Message" ("instanceId", ("key"->>'remoteJid'), "messageTimestamp" DESC);

-- Orden de la lista del inbox (mismo COALESCE que en crm.service.ts).
CREATE INDEX IF NOT EXISTS "Chat_lastMessageAt_idx" ON "Chat" ("lastMessageAt" DESC);

-- Mensaje nuevo: si es mas nuevo que el ultimo conocido, pasa a ser el ultimo.
CREATE OR REPLACE FUNCTION lydia_chat_last_message_on_insert() RETURNS trigger AS $$
BEGIN
  UPDATE "Chat"
  SET "lastMessageAt" = NEW."messageTimestamp", "lastMessageId" = NEW."id"
  WHERE "instanceId" = NEW."instanceId"
    AND "remoteJid" = NEW."key"->>'remoteJid'
    AND ("lastMessageAt" IS NULL OR "lastMessageAt" <= NEW."messageTimestamp");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Message_chat_last_message_insert"
  AFTER INSERT ON "Message"
  FOR EACH ROW EXECUTE FUNCTION lydia_chat_last_message_on_insert();

-- Se borra el que era el ultimo: se busca el anterior (o queda NULL).
CREATE OR REPLACE FUNCTION lydia_chat_last_message_on_delete() RETURNS trigger AS $$
BEGIN
  -- Sin filas, la subconsulta deja ambas columnas en NULL.
  UPDATE "Chat"
  SET ("lastMessageAt", "lastMessageId") = (
    SELECT m."messageTimestamp", m."id" FROM "Message" m
    WHERE m."instanceId" = OLD."instanceId" AND m."key"->>'remoteJid' = OLD."key"->>'remoteJid'
    ORDER BY m."messageTimestamp" DESC, m."id" DESC
    LIMIT 1
  )
  WHERE "lastMessageId" = OLD."id";
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Message_chat_last_message_delete"
  AFTER DELETE ON "Message"
  FOR EACH ROW EXECUTE FUNCTION lydia_chat_last_message_on_delete();

-- Chat creado despues de sus mensajes (pasa: algunos canales insertan el
-- mensaje antes de crear el Chat): arranca con el ultimo que ya existe.
CREATE OR REPLACE FUNCTION lydia_chat_last_message_on_chat_insert() RETURNS trigger AS $$
BEGIN
  IF NEW."lastMessageAt" IS NULL THEN
    SELECT m."messageTimestamp", m."id" INTO NEW."lastMessageAt", NEW."lastMessageId"
    FROM "Message" m
    WHERE m."instanceId" = NEW."instanceId" AND m."key"->>'remoteJid' = NEW."remoteJid"
    ORDER BY m."messageTimestamp" DESC, m."id" DESC
    LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Chat_last_message_on_insert"
  BEFORE INSERT ON "Chat"
  FOR EACH ROW EXECUTE FUNCTION lydia_chat_last_message_on_chat_insert();

-- Relleno de los chats que ya existen.
UPDATE "Chat" c
SET "lastMessageAt" = last."messageTimestamp", "lastMessageId" = last."id"
FROM (
  SELECT DISTINCT ON (m."instanceId", m."key"->>'remoteJid')
    m."instanceId", m."key"->>'remoteJid' AS "remoteJid", m."messageTimestamp", m."id"
  FROM "Message" m
  ORDER BY m."instanceId", m."key"->>'remoteJid', m."messageTimestamp" DESC, m."id" DESC
) AS last
WHERE c."instanceId" = last."instanceId" AND c."remoteJid" = last."remoteJid";
