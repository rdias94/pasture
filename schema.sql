-- ================================================================
-- PORTAL PASTURE — Schema D1 (pasture-db)
-- Idempotente: pode rodar várias vezes sem quebrar.
-- Espelha exatamente o que worker_api.js espera.
-- ================================================================

CREATE TABLE IF NOT EXISTS usuarios (
  id        TEXT PRIMARY KEY,
  nome      TEXT NOT NULL UNIQUE,
  senha     TEXT NOT NULL,
  perfil    TEXT NOT NULL DEFAULT 'consultor',   -- master | consultor | cliente
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS grupos (
  id            TEXT PRIMARY KEY,
  nome          TEXT NOT NULL,
  doc           TEXT,
  contato       TEXT,
  atualizado_em TEXT
);

CREATE TABLE IF NOT EXISTS fazendas (
  id            TEXT PRIMARY KEY,
  grupo_id      TEXT,
  nome          TEXT NOT NULL,
  municipio     TEXT,
  uf            TEXT,
  area_total_ha REAL,
  atualizado_em TEXT
);

CREATE TABLE IF NOT EXISTS fazenda_consultores (
  fazenda_id   TEXT NOT NULL,
  usuario_nome TEXT NOT NULL,
  PRIMARY KEY (fazenda_id, usuario_nome)
);

CREATE TABLE IF NOT EXISTS dados_basicos (
  fazenda_id      TEXT PRIMARY KEY,
  nome_fazenda    TEXT,
  municipio       TEXT,
  uf              TEXT,
  area_total_ha   REAL,
  area_pastagem_ha REAL,
  coord_lat       REAL,
  coord_lon       REAL,
  chuva_json      TEXT,
  kml_nome        TEXT,
  kml_texto       TEXT,
  atualizado_em   TEXT
);

CREATE TABLE IF NOT EXISTS regua (
  id         TEXT PRIMARY KEY,
  fazenda_id TEXT NOT NULL,
  nivel      TEXT,
  vals_json  TEXT,
  ordem      INTEGER
);

CREATE TABLE IF NOT EXISTS of_config (
  fazenda_id     TEXT PRIMARY KEY,
  carga_ua       REAL,
  seq_ms         REAL,
  seq_aprov      REAL,
  seq_cons       REAL,
  seq_dias       INTEGER,
  seq_meses_json TEXT,
  atualizado_em  TEXT
);

CREATE TABLE IF NOT EXISTS of_areas (
  id            TEXT PRIMARY KEY,
  fazenda_id    TEXT NOT NULL,
  identificacao TEXT,
  area_ha       REAL,
  aee_pct       REAL,
  forrageira    TEXT,
  nivel         TEXT,
  origem        TEXT,
  ordem         INTEGER
);

-- Índices para as buscas por fazenda
CREATE INDEX IF NOT EXISTS idx_fc_fazenda    ON fazenda_consultores (fazenda_id);
CREATE INDEX IF NOT EXISTS idx_regua_fazenda ON regua (fazenda_id);
CREATE INDEX IF NOT EXISTS idx_ofareas_fazenda ON of_areas (fazenda_id);
CREATE INDEX IF NOT EXISTS idx_fazendas_grupo ON fazendas (grupo_id);
