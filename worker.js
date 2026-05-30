/**
 * Cloudflare Worker — Proxy SICAR v2.1
 * pasture.rdias94.workers.dev
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const SICAR = 'https://geoserver.car.gov.br/geoserver/sicar';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      if (path.startsWith('/tiles/')) return await handleTile(url, path);
      if (path === '/click') return await handleClick(url);
      if (path === '/camadas') return await handleCamadas(url);
      if (path === '/' || path === '/health') return json({ status: 'ok', worker: 'pasture-sicar-proxy', v: '2.1' });
      return json({ error: 'Endpoint nao encontrado' }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }
};

// Proxy de tiles WMS
async function handleTile(url, path) {
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 5) return json({ error: 'Path invalido' }, 400);
  const uf = parts[1].toLowerCase();
  const z = parseInt(parts[2]);
  const y = parseInt(parts[3]);
  const x = parseInt(parts[4]);
  const bbox = tileToBBox(x, y, z);

  const wmsUrl = SICAR + '/wms?service=WMS&version=1.1.1&request=GetMap'
    + '&layers=sicar:sicar_imoveis_' + uf
    + '&bbox=' + bbox
    + '&width=256&height=256&srs=EPSG:4326'
    + '&format=image/png&transparent=true&styles=';

  const resp = await fetch(wmsUrl, {
    headers: { 'User-Agent': 'PastureApp/2.1' },
    cf: { cacheTtl: 3600, cacheEverything: true }
  });
  const img = await resp.arrayBuffer();
  return new Response(img, {
    headers: { ...CORS, 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' }
  });
}

// Busca imovel pelo ponto clicado — usa BBOX direto (sem CQL_FILTER)
async function handleClick(url) {
  const lat = parseFloat(url.searchParams.get('lat'));
  const lon = parseFloat(url.searchParams.get('lon'));
  const uf = (url.searchParams.get('uf') || 'GO').toLowerCase();
  if (isNaN(lat) || isNaN(lon)) return json({ error: 'lat e lon obrigatorios' }, 400);

  const delta = 0.005;
  const bbox = (lon-delta) + ',' + (lat-delta) + ',' + (lon+delta) + ',' + (lat+delta) + ',EPSG:4326';

  const wfsUrl = SICAR + '/wfs?service=WFS&version=2.0.0&request=GetFeature'
    + '&typeName=sicar:sicar_imoveis_' + uf
    + '&outputFormat=application/json'
    + '&BBOX=' + bbox
    + '&count=5&srsName=EPSG:4326';

  const resp = await fetch(wfsUrl, {
    headers: { 'User-Agent': 'PastureApp/2.1' },
    cf: { cacheTtl: 30, cacheEverything: false }
  });
  if (!resp.ok) {
    const txt = await resp.text();
    return json({ error: 'SICAR erro ' + resp.status, detail: txt.slice(0, 400) }, 502);
  }
  const geojson = await resp.json();
  return new Response(JSON.stringify(geojson), {
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

// Busca camadas ambientais — APP, Reserva Legal, Uso Restrito
async function handleCamadas(url) {
  const bbox = url.searchParams.get('bbox');
  const uf = (url.searchParams.get('uf') || 'GO').toLowerCase();
  const tipo = url.searchParams.get('tipo') || 'app';
  const numero = url.searchParams.get('numero');

  const layerMap = {
    app:     'sicar:sicar_apps_' + uf,
    reserva: 'sicar:sicar_reserva_legal_' + uf,
    uso:     'sicar:sicar_uso_restrito_' + uf,
    imovel:  'sicar:sicar_imoveis_' + uf,
  };
  const layer = layerMap[tipo];
  if (!layer) return json({ error: 'tipo invalido' }, 400);

  let wfsUrl;
  if (numero) {
    // Busca por numero do CAR via CQL_FILTER (funciona para numero exato)
    wfsUrl = SICAR + '/wfs?service=WFS&version=2.0.0&request=GetFeature'
      + '&typeName=' + layer
      + '&outputFormat=application/json'
      + '&CQL_FILTER=' + encodeURIComponent("COD_IMOVEL='" + numero + "'")
      + '&count=20&srsName=EPSG:4326';
  } else if (bbox) {
    // Busca por BBOX direto
    const bboxParam = bbox + ',EPSG:4326';
    wfsUrl = SICAR + '/wfs?service=WFS&version=2.0.0&request=GetFeature'
      + '&typeName=' + layer
      + '&outputFormat=application/json'
      + '&BBOX=' + bboxParam
      + '&count=20&srsName=EPSG:4326';
  } else {
    return json({ error: 'Forneca bbox ou numero' }, 400);
  }

  const resp = await fetch(wfsUrl, {
    headers: { 'User-Agent': 'PastureApp/2.1' },
    cf: { cacheTtl: 300, cacheEverything: true }
  });
  if (!resp.ok) {
    const txt = await resp.text();
    return json({ error: 'SICAR erro ' + resp.status, detail: txt.slice(0, 400) }, 502);
  }
  const geojson = await resp.json();
  return new Response(JSON.stringify(geojson), {
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' }
  });
}

function tileToBBox(x, y, z) {
  const n = Math.pow(2, z);
  const west  = (x / n) * 360 - 180;
  const east  = ((x + 1) / n) * 360 - 180;
  const north = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
  const south = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
  return west + ',' + south + ',' + east + ',' + north;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}
