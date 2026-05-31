-- ================================================================
-- PORTAL PASTURE — Schema D1 (pasture-db)
-- Idempotente (CREATE TABLE IF NOT EXISTS): pode rodar várias vezes.
-- Espelha EXATAMENTE o banco de produção (com foreign keys + defaults).
-- ================================================================

CREATE TABLE IF NOT EXISTS usuarios (
  id        TEXT PRIMARY KEY,
  nome      TEXT NOT NULL UNIQUE,
  senha     TEXT NOT NULL,
  perfil    TEXT DEFAULT 'consultor',          -- master | consultor | cliente
  criado_em TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS grupos (
  id            TEXT PRIMARY KEY,
  nome          TEXT NOT NULL,
  doc           TEXT,
  contato       TEXT,
  criado_em     TEXT DEFAULT (datetime('now')),
  atualizado_em TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fazendas (
  id            TEXT PRIMARY KEY,
  grupo_id      TEXT REFERENCES grupos(id),
  nome          TEXT NOT NULL,
  municipio     TEXT,
  uf            TEXT,
  area_total_ha REAL,
  criado_em     TEXT DEFAULT (datetime('now')),
  atualizado_em TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fazenda_consultores (
  fazenda_id   TEXT REFERENCES fazendas(id),
  usuario_nome TEXT,
  PRIMARY KEY (fazenda_id, usuario_nome)
);

CREATE TABLE IF NOT EXISTS dados_basicos (
  fazenda_id       TEXT PRIMARY KEY REFERENCES fazendas(id),
  nome_fazenda     TEXT,
  municipio        TEXT,
  uf               TEXT,
  area_total_ha    REAL,
  area_pastagem_ha REAL,
  coord_lat        REAL,
  coord_lon        REAL,
  chuva_json       TEXT,
  kml_nome         TEXT,
  kml_texto        TEXT,                 -- legado (KML cru); migrado p/ R2 + estrutura
  kml_estrutura_json TEXT,               -- estrutura parseada (render sem reparse)
  kml_r2_key       TEXT,                 -- chave do arquivo original no bucket R2
  atualizado_em    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS regua (
  id         TEXT PRIMARY KEY,
  fazenda_id TEXT REFERENCES fazendas(id),
  nivel      TEXT NOT NULL,
  vals_json  TEXT NOT NULL,
  ordem      INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS of_config (
  fazenda_id     TEXT PRIMARY KEY REFERENCES fazendas(id),
  carga_ua       REAL,
  seq_ms         REAL,
  seq_aprov      REAL DEFAULT 85,
  seq_cons       REAL DEFAULT 10.935,
  seq_dias       REAL DEFAULT 30,
  seq_meses_json TEXT DEFAULT '[]',
  atualizado_em  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS of_areas (
  id            TEXT PRIMARY KEY,
  fazenda_id    TEXT REFERENCES fazendas(id),
  identificacao TEXT,
  area_ha       REAL,
  aee_pct       REAL DEFAULT 100,
  forrageira    TEXT,
  nivel         TEXT,
  origem        TEXT DEFAULT 'manual',
  ordem         INTEGER DEFAULT 0
);

-- Índices para as buscas por fazenda
CREATE INDEX IF NOT EXISTS idx_fc_fazenda      ON fazenda_consultores (fazenda_id);
CREATE INDEX IF NOT EXISTS idx_regua_fazenda   ON regua (fazenda_id);
CREATE INDEX IF NOT EXISTS idx_ofareas_fazenda ON of_areas (fazenda_id);
CREATE INDEX IF NOT EXISTS idx_fazendas_grupo  ON fazendas (grupo_id);
