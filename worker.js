/**
 * Cloudflare Worker — Proxy SICAR
 * pasture.rdias94.workers.dev
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const SICAR_GEOSERVER = 'https://geoserver.car.gov.br/geoserver';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      // ── /tiles/{uf}/{z}/{y}/{x} — proxy de tiles WMS do SICAR ──
      if (path.startsWith('/tiles/')) {
        return await handleTile(url, path);
      }

      // ── /click?lat=&lon=&uf= — busca imóvel pelo ponto clicado ─
      if (path === '/click') {
        return await handleClick(url);
      }

      // ── /camadas?numero=&uf=&tipo= — APP, RL, Uso Restrito ─────
      if (path === '/camadas') {
        return await handleCamadas(url);
      }

      // ── /health ────────────────────────────────────────────────
      if (path === '/' || path === '/health') {
        return jsonResponse({ status: 'ok', worker: 'pasture-sicar-proxy', v: '2.0' });
      }

      return jsonResponse({ error: 'Endpoint não encontrado' }, 404);

    } catch (err) {
      return jsonResponse({ error: err.message }, 500);
    }
  }
};

// ── Proxy de tiles WMS → converte em tiles XYZ ──────────────────
async function handleTile(url, path) {
  // path: /tiles/{uf}/{z}/{y}/{x}
  const parts = path.split('/').filter(Boolean);
  // parts: ['tiles', uf, z, y, x]
  if (parts.length < 5) return jsonResponse({ error: 'Path inválido' }, 400);

  const uf = parts[1].toLowerCase();
  const z = parseInt(parts[2]);
  const y = parseInt(parts[3]);
  const x = parseInt(parts[4]);

  // Converter tile XYZ para BBOX EPSG:4326
  const bbox = tileToBBox(x, y, z);

  const wmsUrl = new URL(SICAR_GEOSERVER + '/sicar/wms');
  wmsUrl.searchParams.set('service', 'WMS');
  wmsUrl.searchParams.set('version', '1.1.1');
  wmsUrl.searchParams.set('request', 'GetMap');
  wmsUrl.searchParams.set('layers', 'sicar:sicar_imoveis_' + uf);
  wmsUrl.searchParams.set('bbox', bbox);
  wmsUrl.searchParams.set('width', '256');
  wmsUrl.searchParams.set('height', '256');
  wmsUrl.searchParams.set('srs', 'EPSG:4326');
  wmsUrl.searchParams.set('format', 'image/png');
  wmsUrl.searchParams.set('transparent', 'true');
  wmsUrl.searchParams.set('styles', '');

  const resp = await fetch(wmsUrl.toString(), {
    headers: { 'User-Agent': 'PastureApp/2.0' },
    cf: { cacheTtl: 3600, cacheEverything: true }
  });

  const img = await resp.arrayBuffer();
  return new Response(img, {
    headers: {
      ...CORS,
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=3600'
    }
  });
}

// ── Busca imóvel pelo ponto clicado (GetFeatureInfo via WFS) ─────
async function handleClick(url) {
  const lat = parseFloat(url.searchParams.get('lat'));
  const lon = parseFloat(url.searchParams.get('lon'));
  const uf  = (url.searchParams.get('uf') || 'GO').toLowerCase();

  if (isNaN(lat) || isNaN(lon)) {
    return jsonResponse({ error: 'lat e lon obrigatórios' }, 400);
  }

  // Criar bbox pequeno ao redor do ponto clicado (~200m)
  const delta = 0.002;
  const bbox = (lon-delta) + ',' + (lat-delta) + ',' + (lon+delta) + ',' + (lat+delta);

  const wfsUrl = new URL(SICAR_GEOSERVER + '/sicar/wfs');
  wfsUrl.searchParams.set('service', 'WFS');
  wfsUrl.searchParams.set('version', '2.0.0');
  wfsUrl.searchParams.set('request', 'GetFeature');
  wfsUrl.searchParams.set('typeName', 'sicar:sicar_imoveis_' + uf);
  wfsUrl.searchParams.set('outputFormat', 'application/json');
  wfsUrl.searchParams.set('CQL_FILTER', 'BBOX(geometry,' + bbox + ",'EPSG:4326')");
  wfsUrl.searchParams.set('count', '5');
  wfsUrl.searchParams.set('srsName', 'EPSG:4326');

  const resp = await fetch(wfsUrl.toString(), {
    headers: { 'User-Agent': 'PastureApp/2.0' },
    cf: { cacheTtl: 60, cacheEverything: false }
  });

  if (!resp.ok) {
    const txt = await resp.text();
    return jsonResponse({ error: 'SICAR erro ' + resp.status, detail: txt.slice(0,300) }, 502);
  }

  const geojson = await resp.json();
  return new Response(JSON.stringify(geojson), {
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

// ── Busca camadas ambientais (APP, RL, Uso Restrito) ─────────────
async function handleCamadas(url) {
  const numero = url.searchParams.get('numero');
  const bbox   = url.searchParams.get('bbox');
  const uf     = (url.searchParams.get('uf') || 'GO').toLowerCase();
  const tipo   = url.searchParams.get('tipo') || 'app';

  const layerMap = {
    app:    'sicar:sicar_apps_' + uf,
    reserva:'sicar:sicar_reserva_legal_' + uf,
    uso:    'sicar:sicar_uso_restrito_' + uf,
    imovel: 'sicar:sicar_imoveis_' + uf,
  };

  const layer = layerMap[tipo];
  if (!layer) return jsonResponse({ error: 'tipo inválido' }, 400);

  let cql = '';
  if (numero) {
    cql = "COD_IMOVEL='" + numero + "'";
  } else if (bbox) {
    cql = 'BBOX(geometry,' + bbox + ",'EPSG:4326')";
  } else {
    return jsonResponse({ error: 'Forneça numero ou bbox' }, 400);
  }

  const wfsUrl = new URL(SICAR_GEOSERVER + '/sicar/wfs');
  wfsUrl.searchParams.set('service', 'WFS');
  wfsUrl.searchParams.set('version', '2.0.0');
  wfsUrl.searchParams.set('request', 'GetFeature');
  wfsUrl.searchParams.set('typeName', layer);
  wfsUrl.searchParams.set('outputFormat', 'application/json');
  wfsUrl.searchParams.set('CQL_FILTER', cql);
  wfsUrl.searchParams.set('count', '20');
  wfsUrl.searchParams.set('srsName', 'EPSG:4326');

  const resp = await fetch(wfsUrl.toString(), {
    headers: { 'User-Agent': 'PastureApp/2.0' },
    cf: { cacheTtl: 300, cacheEverything: true }
  });

  if (!resp.ok) {
    const txt = await resp.text();
    return jsonResponse({ error: 'SICAR erro ' + resp.status, detail: txt.slice(0,300) }, 502);
  }

  const geojson = await resp.json();
  return new Response(JSON.stringify(geojson), {
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' }
  });
}

// ── Converter tile XYZ para BBOX EPSG:4326 ──────────────────────
function tileToBBox(x, y, z) {
  const n = Math.pow(2, z);
  const west  =  (x / n) * 360 - 180;
  const east  =  ((x + 1) / n) * 360 - 180;
  const north =  Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
  const south =  Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
  return west + ',' + south + ',' + east + ',' + north;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}
