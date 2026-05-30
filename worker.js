/**
 * Cloudflare Worker — Proxy SICAR + SIAGAS
 * Repositório: rdias94/pasture
 * 
 * Endpoints disponíveis:
 *   GET /car?bbox=minx,miny,maxx,maxy&uf=GO&tipo=imoveis
 *   GET /car?numero=GO-5211404-67A1CB8D68D4459C9656A9...
 *   GET /car/app?bbox=...&uf=GO
 *   GET /car/reserva?bbox=...&uf=GO
 *   GET /siagas?lat=-17.93&lon=-51.71&raio=10000
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const SICAR_BASE = 'https://geoserver.car.gov.br/geoserver/sicar/wfs';
const SIAGAS_BASE = 'https://siagasweb.cprm.gov.br/layout/pesquisa_complexa.php';

// Camadas disponíveis por tipo
const SICAR_LAYERS = {
  imoveis:  (uf) => `sicar:sicar_imoveis_${uf.toLowerCase()}`,
  app:      (uf) => `sicar:sicar_apps_${uf.toLowerCase()}`,
  reserva:  (uf) => `sicar:sicar_reserva_legal_${uf.toLowerCase()}`,
  uso:      (uf) => `sicar:sicar_uso_restrito_${uf.toLowerCase()}`,
  hidrografia: (uf) => `sicar:sicar_hidrografia_${uf.toLowerCase()}`,
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      // ── /car — consulta WFS SICAR ──────────────────────────────
      if (path === '/car' || path === '/car/') {
        return await handleCAR(url, 'imoveis');
      }

      // ── /car/app — APP (Área de Preservação Permanente) ────────
      if (path === '/car/app') {
        return await handleCAR(url, 'app');
      }

      // ── /car/reserva — Reserva Legal ──────────────────────────
      if (path === '/car/reserva') {
        return await handleCAR(url, 'reserva');
      }

      // ── /car/uso — Uso Restrito ────────────────────────────────
      if (path === '/car/uso') {
        return await handleCAR(url, 'uso');
      }

      // ── /car/todas — todas as camadas de uma vez ───────────────
      if (path === '/car/todas') {
        return await handleTodasCamadas(url);
      }

      // ── /siagas — poços artesianos CPRM ───────────────────────
      if (path === '/siagas') {
        return await handleSIAGAS(url);
      }

      // ── / — health check ───────────────────────────────────────
      if (path === '/' || path === '/health') {
        return jsonResponse({ status: 'ok', worker: 'pasture-proxy', version: '1.0' });
      }

      return jsonResponse({ error: 'Endpoint não encontrado', path }, 404);

    } catch (err) {
      return jsonResponse({ error: err.message }, 500);
    }
  }
};

// ── Handler principal SICAR WFS ──────────────────────────────────
async function handleCAR(url, tipoDefault) {
  const bbox   = url.searchParams.get('bbox');
  const uf     = (url.searchParams.get('uf') || 'GO').toUpperCase();
  const tipo   = url.searchParams.get('tipo') || tipoDefault;
  const numero = url.searchParams.get('numero'); // número do CAR
  const limit  = url.searchParams.get('limit') || '50';

  const layerFn = SICAR_LAYERS[tipo];
  if (!layerFn) {
    return jsonResponse({ error: 'Tipo inválido. Use: imoveis, app, reserva, uso, hidrografia' }, 400);
  }

  const layer = layerFn(uf);

  // Montar CQL_FILTER
  let cqlFilter = '';
  if (numero) {
    // Busca por número do CAR
    cqlFilter = `COD_IMOVEL='${numero}'`;
  } else if (bbox) {
    // Busca por bounding box
    // BBOX formato: minLon,minLat,maxLon,maxLat
    cqlFilter = `BBOX(geometry,${bbox},'EPSG:4326')`;
  } else {
    return jsonResponse({ error: 'Forneça bbox ou numero do CAR' }, 400);
  }

  const wfsUrl = new URL(SICAR_BASE);
  wfsUrl.searchParams.set('service', 'WFS');
  wfsUrl.searchParams.set('version', '2.0.0');
  wfsUrl.searchParams.set('request', 'GetFeature');
  wfsUrl.searchParams.set('typeName', layer);
  wfsUrl.searchParams.set('outputFormat', 'application/json');
  wfsUrl.searchParams.set('CQL_FILTER', cqlFilter);
  wfsUrl.searchParams.set('count', limit);
  wfsUrl.searchParams.set('srsName', 'EPSG:4326');

  const resp = await fetch(wfsUrl.toString(), {
    headers: { 'User-Agent': 'PastureApp/1.0 (agro planning tool)' },
    cf: { cacheTtl: 300, cacheEverything: true } // cache 5 min
  });

  if (!resp.ok) {
    const text = await resp.text();
    return jsonResponse({ error: 'SICAR retornou erro', status: resp.status, detail: text.slice(0, 500) }, 502);
  }

  const geojson = await resp.json();

  // Enriquecer features com metadados úteis
  if (geojson.features) {
    geojson.features = geojson.features.map(f => ({
      ...f,
      properties: {
        ...f.properties,
        _tipo: tipo,
        _uf: uf,
        _layer: layer
      }
    }));
  }

  return new Response(JSON.stringify(geojson), {
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' }
  });
}

// ── Handler todas as camadas de um imóvel ────────────────────────
async function handleTodasCamadas(url) {
  const numero = url.searchParams.get('numero');
  const bbox   = url.searchParams.get('bbox');
  const uf     = (url.searchParams.get('uf') || 'GO').toUpperCase();

  if (!numero && !bbox) {
    return jsonResponse({ error: 'Forneça numero ou bbox' }, 400);
  }

  const tipos = ['imoveis', 'app', 'reserva', 'uso'];

  // Buscar todas em paralelo
  const resultados = await Promise.allSettled(
    tipos.map(async (tipo) => {
      const u = new URL(url.toString());
      u.searchParams.set('tipo', tipo);
      const r = await handleCAR(u, tipo);
      const data = await r.json();
      return { tipo, data };
    })
  );

  const combined = { type: 'FeatureCollection', camadas: {} };
  resultados.forEach(res => {
    if (res.status === 'fulfilled') {
      combined.camadas[res.value.tipo] = res.value.data;
    }
  });

  return new Response(JSON.stringify(combined), {
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

// ── Handler SIAGAS — poços artesianos ────────────────────────────
async function handleSIAGAS(url) {
  const lat  = url.searchParams.get('lat');
  const lon  = url.searchParams.get('lon');
  const raio = url.searchParams.get('raio') || '10000'; // metros

  if (!lat || !lon) {
    return jsonResponse({ error: 'Forneça lat e lon' }, 400);
  }

  // SIAGAS REST API — busca por ponto e raio
  const siagasUrl = new URL('https://siagasweb.cprm.gov.br/layout/pesquisa_complexa.php');
  siagasUrl.searchParams.set('lat', lat);
  siagasUrl.searchParams.set('lon', lon);
  siagasUrl.searchParams.set('raio', raio);
  siagasUrl.searchParams.set('tipo', 'json');

  try {
    const resp = await fetch(siagasUrl.toString(), {
      headers: { 'User-Agent': 'PastureApp/1.0' },
      cf: { cacheTtl: 3600, cacheEverything: true }
    });

    if (!resp.ok) throw new Error('SIAGAS HTTP ' + resp.status);
    const data = await resp.json();
    return new Response(JSON.stringify(data), {
      headers: { ...CORS, 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return jsonResponse({ error: 'SIAGAS indisponível: ' + err.message, dados: [] }, 200);
  }
}

// ── Helpers ──────────────────────────────────────────────────────
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}
