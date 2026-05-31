// ================================================================
// PORTAL PASTURE — Cloudflare Worker API
// D1: pasture-db | binding: DB
// ================================================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function err(msg, status = 400) {
  return json({ error: msg }, status);
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ── AUTH ─────────────────────────────────────────────────────────
async function authMiddleware(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token) return null;
  // token = base64(nome:senha)
  try {
    const decoded = atob(token);
    const [nome, senha] = decoded.split(':');
    const row = await env.DB.prepare(
      'SELECT * FROM usuarios WHERE nome=? AND senha=?'
    ).bind(nome, senha).first();
    return row || null;
  } catch {
    return null;
  }
}

// ================================================================
// ROUTER
// ================================================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '');
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ── LOGIN ─────────────────────────────────────────────────────
    if (path === '/api/login' && method === 'POST') {
      const { nome, senha } = await request.json();
      const row = await env.DB.prepare(
        'SELECT id, nome, perfil FROM usuarios WHERE nome=? AND senha=?'
      ).bind(nome, senha).first();
      if (!row) return err('Usuário ou senha incorretos', 401);
      const token = btoa(`${nome}:${senha}`);
      return json({ token, usuario: row });
    }

    // Todas as outras rotas exigem auth
    const usuario = await authMiddleware(request, env);
    if (!usuario) return err('Não autorizado', 401);

    // ── TROCAR PRÓPRIA SENHA ──────────────────────────────────────
    if (path === '/api/me/senha' && method === 'POST') {
      const { senhaNova } = await request.json();
      if (!senhaNova || String(senhaNova).length < 4) {
        return err('Senha muito curta (mínimo 4 caracteres)', 400);
      }
      await env.DB.prepare('UPDATE usuarios SET senha=? WHERE id=?')
        .bind(senhaNova, usuario.id).run();
      // novo token (base64 nome:senha) pro frontend seguir autenticado
      return json({ ok: true, token: btoa(`${usuario.nome}:${senhaNova}`) });
    }

    // ── GRUPOS ────────────────────────────────────────────────────
    if (path === '/api/grupos') {
      if (method === 'GET') {
        const { results } = await env.DB.prepare('SELECT * FROM grupos ORDER BY nome').all();
        return json(results);
      }
      if (method === 'POST') {
        const b = await request.json();
        const id = b.id || uid();
        await env.DB.prepare(
          'INSERT OR REPLACE INTO grupos (id,nome,doc,contato,atualizado_em) VALUES (?,?,?,?,datetime("now"))'
        ).bind(id, b.nome, b.doc || null, b.contato || null).run();
        return json({ id });
      }
    }

    if (path.match(/^\/api\/grupos\/[\w-]+$/) && method === 'PUT') {
      const id = path.split('/').pop();
      const b = await request.json();
      await env.DB.prepare(
        'UPDATE grupos SET nome=?,doc=?,contato=?,atualizado_em=datetime("now") WHERE id=?'
      ).bind(b.nome, b.doc || null, b.contato || null, id).run();
      return json({ ok: true });
    }

    // ── USUÁRIOS ──────────────────────────────────────────────────
    if (path === '/api/usuarios') {
      if (method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT id, nome, perfil, criado_em FROM usuarios ORDER BY nome'
        ).all();
        return json(results);
      }
      if (method === 'POST') {
        if (usuario.perfil !== 'master') return err('Sem permissão', 403);
        const b = await request.json();
        const id = uid();
        await env.DB.prepare(
          'INSERT INTO usuarios (id,nome,senha,perfil) VALUES (?,?,?,?)'
        ).bind(id, b.nome, b.senha, b.perfil || 'consultor').run();
        return json({ id });
      }
    }

    if (path.match(/^\/api\/usuarios\/[\w-]+$/) && method === 'DELETE') {
      if (usuario.perfil !== 'master') return err('Sem permissão', 403);
      const nome = path.split('/').pop();
      await env.DB.prepare('DELETE FROM usuarios WHERE nome=?').bind(nome).run();
      return json({ ok: true });
    }

    // ── FAZENDAS ──────────────────────────────────────────────────
    if (path === '/api/fazendas') {
      if (method === 'GET') {
        const { results: fazendas } = await env.DB.prepare(
          'SELECT f.*, GROUP_CONCAT(fc.usuario_nome) as consultores_str FROM fazendas f LEFT JOIN fazenda_consultores fc ON f.id=fc.fazenda_id GROUP BY f.id ORDER BY f.nome'
        ).all();
        return json(fazendas.map(f => ({
          ...f,
          consultores: f.consultores_str ? f.consultores_str.split(',') : []
        })));
      }
      if (method === 'POST') {
        const b = await request.json();
        const id = b.id || uid();
        await env.DB.prepare(
          'INSERT OR REPLACE INTO fazendas (id,grupo_id,nome,municipio,uf,area_total_ha,atualizado_em) VALUES (?,?,?,?,?,?,datetime("now"))'
        ).bind(id, b.grupoId || null, b.nome, b.municipio || null, b.uf || null, b.areaTotalHa || null).run();
        // Consultores
        await env.DB.prepare('DELETE FROM fazenda_consultores WHERE fazenda_id=?').bind(id).run();
        for (const c of (b.consultores || [])) {
          await env.DB.prepare(
            'INSERT OR IGNORE INTO fazenda_consultores (fazenda_id,usuario_nome) VALUES (?,?)'
          ).bind(id, c).run();
        }
        return json({ id });
      }
    }

    if (path.match(/^\/api\/fazendas\/[\w-]+$/) && method === 'PUT') {
      const id = path.split('/').pop();
      const b = await request.json();
      await env.DB.prepare(
        'UPDATE fazendas SET grupo_id=?,nome=?,municipio=?,uf=?,area_total_ha=?,atualizado_em=datetime("now") WHERE id=?'
      ).bind(b.grupoId || null, b.nome, b.municipio || null, b.uf || null, b.areaTotalHa || null, id).run();
      await env.DB.prepare('DELETE FROM fazenda_consultores WHERE fazenda_id=?').bind(id).run();
      for (const c of (b.consultores || [])) {
        await env.DB.prepare(
          'INSERT OR IGNORE INTO fazenda_consultores (fazenda_id,usuario_nome) VALUES (?,?)'
        ).bind(id, c).run();
      }
      return json({ ok: true });
    }

    // ── DADOS BÁSICOS ─────────────────────────────────────────────
    const mDados = path.match(/^\/api\/fazendas\/([\w-]+)\/dados$/);
    if (mDados) {
      const fazId = mDados[1];
      if (method === 'GET') {
        const row = await env.DB.prepare(
          'SELECT * FROM dados_basicos WHERE fazenda_id=?'
        ).bind(fazId).first();
        if (!row) return json(null);
        return json({
          ...row,
          chuva: row.chuva_json ? JSON.parse(row.chuva_json) : [],
        });
      }
      if (method === 'PUT') {
        const b = await request.json();
        // Upsert SEM tocar em kml_nome/kml_texto — KML é gerido só por /kml,
        // evitando qualquer corrida que apague o KML salvo.
        await env.DB.prepare(
          'INSERT OR IGNORE INTO dados_basicos (fazenda_id) VALUES (?)'
        ).bind(fazId).run();
        await env.DB.prepare(`
          UPDATE dados_basicos SET
            nome_fazenda=?, municipio=?, uf=?,
            area_total_ha=?, area_pastagem_ha=?,
            coord_lat=?, coord_lon=?, chuva_json=?,
            atualizado_em=datetime('now')
          WHERE fazenda_id=?
        `).bind(
          b.nomeFazenda || null, b.municipio || null, b.uf || null,
          b.areaTotalHa || null, b.areaPastagemHa || null,
          b.coordLat || null, b.coordLon || null,
          JSON.stringify(b.chuva || []),
          fazId
        ).run();
        // Atualizar fazenda também
        await env.DB.prepare(
          'UPDATE fazendas SET municipio=?,uf=?,area_total_ha=?,atualizado_em=datetime("now") WHERE id=?'
        ).bind(b.municipio || null, b.uf || null, b.areaTotalHa || null, fazId).run();
        return json({ ok: true });
      }
    }

    // ── KML (só o texto, separado para não pesar nas listagens) ───
    const mKml = path.match(/^\/api\/fazendas\/([\w-]+)\/kml$/);
    if (mKml) {
      const fazId = mKml[1];
      if (method === 'GET') {
        const row = await env.DB.prepare(
          'SELECT kml_nome, kml_texto FROM dados_basicos WHERE fazenda_id=?'
        ).bind(fazId).first();
        return json(row || null);
      }
      if (method === 'PUT') {
        const b = await request.json();
        // Upsert: insert if not exists, then update kml fields
        await env.DB.prepare(
          'INSERT OR IGNORE INTO dados_basicos (fazenda_id) VALUES (?)'
        ).bind(fazId).run();
        await env.DB.prepare(
          'UPDATE dados_basicos SET kml_nome=?,kml_texto=?,atualizado_em=datetime("now") WHERE fazenda_id=?'
        ).bind(b.kmlNome, b.kmlTexto, fazId).run();
        return json({ ok: true });
      }
    }

    // ── RÉGUA ─────────────────────────────────────────────────────
    const mRegua = path.match(/^\/api\/fazendas\/([\w-]+)\/regua$/);
    if (mRegua) {
      const fazId = mRegua[1];
      if (method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM regua WHERE fazenda_id=? ORDER BY ordem'
        ).bind(fazId).all();
        return json(results.map(r => ({
          rid: r.id, nivel: r.nivel,
          vals: JSON.parse(r.vals_json)
        })));
      }
      if (method === 'PUT') {
        const linhas = await request.json();
        await env.DB.prepare('DELETE FROM regua WHERE fazenda_id=?').bind(fazId).run();
        for (let i = 0; i < linhas.length; i++) {
          const l = linhas[i];
          await env.DB.prepare(
            'INSERT INTO regua (id,fazenda_id,nivel,vals_json,ordem) VALUES (?,?,?,?,?)'
          ).bind(l.rid || uid(), fazId, l.nivel, JSON.stringify(l.vals), i).run();
        }
        return json({ ok: true });
      }
    }

    // ── ORÇAMENTAÇÃO FORRAGEIRA ───────────────────────────────────
    const mOF = path.match(/^\/api\/fazendas\/([\w-]+)\/of$/);
    if (mOF) {
      const fazId = mOF[1];
      if (method === 'GET') {
        const config = await env.DB.prepare(
          'SELECT * FROM of_config WHERE fazenda_id=?'
        ).bind(fazId).first();
        const { results: areas } = await env.DB.prepare(
          'SELECT * FROM of_areas WHERE fazenda_id=? ORDER BY ordem'
        ).bind(fazId).all();
        return json({
          config: config || {},
          areas: areas.map(a => ({
            id: a.identificacao, ha: a.area_ha, aee: a.aee_pct,
            forrageira: a.forrageira, nivel: a.nivel, origem: a.origem
          }))
        });
      }
      if (method === 'PUT') {
        const b = await request.json();
        // Config
        await env.DB.prepare(`
          INSERT OR REPLACE INTO of_config
            (fazenda_id,carga_ua,seq_ms,seq_aprov,seq_cons,seq_dias,seq_meses_json,atualizado_em)
          VALUES (?,?,?,?,?,?,?,datetime('now'))
        `).bind(
          fazId,
          b.cargaUA || null, b.seqMS || null,
          b.seqAprov || 85, b.seqCons || 10.935, b.seqDias || 30,
          JSON.stringify(b.seqMesesSel || [])
        ).run();
        // Areas
        await env.DB.prepare('DELETE FROM of_areas WHERE fazenda_id=?').bind(fazId).run();
        for (let i = 0; i < (b.areas || []).length; i++) {
          const a = b.areas[i];
          await env.DB.prepare(
            'INSERT INTO of_areas (id,fazenda_id,identificacao,area_ha,aee_pct,forrageira,nivel,origem,ordem) VALUES (?,?,?,?,?,?,?,?,?)'
          ).bind(uid(), fazId, a.id, a.ha || 0, a.aee || 100, a.forrageira || '', a.nivel, a.origem || 'manual', i).run();
        }
        return json({ ok: true });
      }
    }

    return err('Rota não encontrada', 404);
  }
};
