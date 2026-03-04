'use strict';
const express = require('express');
const { pool } = require('../db');

const router = express.Router();

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CACHE_VERSION = 'v3'; // bump to bust cache

function mapProperty(p) {
  const loc   = p.location || {};
  const addr  = loc.address || {};
  const coord = loc.coordinate || {};
  const desc  = p.description || {};
  const flags = p.flags || {};
  const agent = (p.source && p.source.agents && p.source.agents[0]) || {};
  const photo = p.primary_photo ? p.primary_photo.href : null;

  const typeRaw = (desc.type || '').toLowerCase();
  const isCommercial = ['multi_family','land','farm'].includes(typeRaw);
  const type = isCommercial ? 'commercial' : 'residential';

  let status = 'active';
  if (flags.is_pending)    status = 'pending';
  if (flags.is_contingent) status = 'pending';

  const fullAddr = [addr.line, addr.city, addr.state_code, addr.postal_code].filter(Boolean).join(', ');

  return {
    id:          p.property_id || String(Math.random()),
    mlsId:       p.property_id || '—',
    type,
    status,
    subType:     desc.type || 'Residential',
    rawPrice:    p.list_price || 0,
    price:       p.list_price ? '$' + Number(p.list_price).toLocaleString() : 'Price N/A',
    title:       desc.type ? desc.type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Property',
    address:     fullAddr || 'Address unavailable',
    beds:        desc.beds || '—',
    baths:       desc.baths_full || desc.baths || '—',
    sqft:        desc.sqft ? Number(desc.sqft).toLocaleString() : '—',
    year:        desc.year_built || '—',
    lotSize:     desc.lot_sqft ? Number(desc.lot_sqft).toLocaleString() + ' sqft' : '—',
    desc:        'Listed at $' + (p.list_price ? Number(p.list_price).toLocaleString() : 'N/A') + ' · ' + fullAddr,
    img:         photo,
    lat:         coord.lat || null,
    lng:         coord.lon || null,
    agentName:   agent.agent_name || null,
    commentCount: 0,
  };
}

async function geocode(address) {
  try {
    const url = 'https://api.mapbox.com/geocoding/v5/mapbox.places/' +
      encodeURIComponent(address) + '.json?limit=1&access_token=' + process.env.MAPBOX_TOKEN;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.features || !data.features.length) return null;
    const [lng, lat] = data.features[0].center;
    return { lat, lng };
  } catch { return null; }
}

async function geocodeMissing(listings) {
  // Mapbox allows parallel requests — geocode all missing at once
  const missing = listings.filter(l => !l.lat || !l.lng);
  await Promise.all(missing.map(async l => {
    const coords = await geocode(l.address);
    if (coords) { l.lat = coords.lat; l.lng = coords.lng; }
  }));
  return listings;
}

async function fetchFromRapidAPI(body) {
  const resp = await fetch('https://realty-in-us.p.rapidapi.com/properties/v3/list', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
      'X-RapidAPI-Host': 'realty-in-us.p.rapidapi.com',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`RapidAPI ${resp.status}`);
  const json = await resp.json();
  return (json.data && json.data.home_search && json.data.home_search.results) || [];
}

async function getListingsWithCache(cacheKey, queryParams) {
  // Check cache
  const cached = await pool.query(
    `SELECT payload, fetched_at FROM listings_cache WHERE cache_key=$1`,
    [cacheKey]
  );
  if (cached.rows.length) {
    const age = Date.now() - new Date(cached.rows[0].fetched_at).getTime();
    if (age < CACHE_TTL_MS) return cached.rows[0].payload;
  }

  const city       = queryParams.city       || 'San Luis Obispo';
  const state_code = queryParams.state_code || 'CA';

  // Build request body from query params
  const body = {
    limit:   parseInt(queryParams.limit, 10) || 25,
    offset:  0,
    status:  ['for_sale'],
    sort:    { direction: 'desc', field: 'list_date' },
    city,
    state_code,
  };
  if (queryParams.postal_code) body.postal_code = queryParams.postal_code;
  if (queryParams.minprice || queryParams.maxprice) {
    body.list_price = {};
    if (queryParams.minprice) body.list_price.min = parseInt(queryParams.minprice, 10);
    if (queryParams.maxprice) body.list_price.max = parseInt(queryParams.maxprice, 10);
  }
  if (queryParams.type) body.type = [queryParams.type];

  const raw = await fetchFromRapidAPI(body);
  const mapped = raw.map(mapProperty);
  await geocodeMissing(mapped);

  // Upsert cache
  await pool.query(
    `INSERT INTO listings_cache (cache_key, payload, fetched_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (cache_key) DO UPDATE SET payload=$2, fetched_at=NOW()`,
    [cacheKey, JSON.stringify(mapped)]
  );

  return mapped;
}

async function attachCommentCounts(listings) {
  if (!listings.length) return listings;
  const mlsIds = listings.map(l => l.mlsId);
  const result = await pool.query(
    `SELECT listing_mlsid, COUNT(*)::int AS cnt
     FROM comments
     WHERE listing_mlsid = ANY($1)
     GROUP BY listing_mlsid`,
    [mlsIds]
  );
  const counts = {};
  for (const row of result.rows) counts[row.listing_mlsid] = row.cnt;
  return listings.map(l => ({ ...l, commentCount: counts[l.mlsId] || 0 }));
}

// GET /api/v1/listings
router.get('/', async (req, res) => {
  try {
    const ALLOWED = ['limit','city','state_code','postal_code','minprice','maxprice','type'];
    const filtered = {};
    for (const k of ALLOWED) {
      if (req.query[k]) filtered[k] = req.query[k];
    }
    // Include effective defaults in cache key so changing defaults busts the cache
    const effectiveCity  = filtered.city       || 'San Luis Obispo';
    const effectiveState = filtered.state_code || 'CA';
    if (!filtered.city)       filtered.city       = effectiveCity;
    if (!filtered.state_code) filtered.state_code = effectiveState;
    const cacheKey = CACHE_VERSION + ':listings:' + new URLSearchParams(filtered).toString();
    let listings = await getListingsWithCache(cacheKey, filtered);
    listings = await attachCommentCounts(listings);
    res.json(listings);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Failed to fetch listings' });
  }
});

// GET /api/v1/listings/:mlsId
router.get('/:mlsId', async (req, res) => {
  try {
    const cacheKey = 'listing:' + req.params.mlsId;
    const cached = await pool.query(
      `SELECT payload, fetched_at FROM listings_cache WHERE cache_key=$1`,
      [cacheKey]
    );
    if (cached.rows.length) {
      const age = Date.now() - new Date(cached.rows[0].fetched_at).getTime();
      if (age < CACHE_TTL_MS) {
        const listing = cached.rows[0].payload;
        const counts = await attachCommentCounts([listing]);
        return res.json(counts[0]);
      }
    }

    // Search main cache
    const listingsCacheKey = 'listings:';
    let listings;
    try {
      listings = await getListingsWithCache(listingsCacheKey, {});
    } catch {
      return res.status(404).json({ error: 'Listing not found' });
    }

    const listing = listings.find(l => String(l.mlsId) === String(req.params.mlsId));
    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    await pool.query(
      `INSERT INTO listings_cache (cache_key, payload, fetched_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (cache_key) DO UPDATE SET payload=$2, fetched_at=NOW()`,
      [cacheKey, JSON.stringify(listing)]
    );

    const withCount = await attachCommentCounts([listing]);
    res.json(withCount[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
