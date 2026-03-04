'use strict';
const express = require('express');
const { pool } = require('../db');

const router = express.Router();

const ALLOWED_PARAMS = ['limit','status','type','minprice','maxprice','city','postalCode'];
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function mapProperty(p) {
  const prop = p.property || {};
  const addr = p.address || {};
  const geo  = p.geo || {};
  const agent = p.agent || {};
  const st = (prop.subType || prop.type || '').toLowerCase();
  const type = st.indexOf('commercial') > -1 ? 'commercial' : 'residential';
  const rs = (p.mls && p.mls.status) ? p.mls.status.toLowerCase() : 'active';
  const status = rs.indexOf('pend') > -1 ? 'pending' : rs.indexOf('clos') > -1 ? 'closed' : 'active';
  const fullAddr = [addr.streetNumber, addr.streetName, addr.city, addr.state, addr.postalCode].filter(Boolean).join(' ');
  const photos = p.photos || [];
  return {
    id:          p.mlsId || String(Math.random()),
    mlsId:       p.mlsId || '—',
    type,
    status,
    subType:     prop.subType || prop.type || 'Residential',
    rawPrice:    p.listPrice || 0,
    price:       p.listPrice ? '$' + Number(p.listPrice).toLocaleString() : 'Price N/A',
    title:       prop.style || prop.subType || 'Property',
    address:     fullAddr || 'Address unavailable',
    beds:        prop.bedrooms || '—',
    baths:       prop.bathsFull || '—',
    sqft:        prop.area ? Number(prop.area).toLocaleString() : '—',
    year:        prop.yearBuilt || '—',
    lotSize:     prop.lotSize ? prop.lotSize + ' acres' : '—',
    desc:        p.remarks || 'No description provided.',
    img:         photos.length ? photos[0] : null,
    lat:         geo.lat || null,
    lng:         geo.lng || null,
    agentName:   agent.firstName ? agent.firstName + ' ' + (agent.lastName || '') : null,
    commentCount: 0,
  };
}

async function fetchFromSimplyRETS(queryParams) {
  const url = new URL('https://api.simplyrets.com/properties');
  for (const [k, v] of Object.entries(queryParams)) {
    if (ALLOWED_PARAMS.includes(k)) url.searchParams.set(k, v);
  }
  if (!url.searchParams.has('status')) url.searchParams.set('status', 'Active');
  if (!url.searchParams.has('limit'))  url.searchParams.set('limit', '25');

  const creds = Buffer.from(`${process.env.SR_USER}:${process.env.SR_PASS}`).toString('base64');
  const resp = await fetch(url.toString(), {
    headers: { 'Authorization': `Basic ${creds}`, 'Accept': 'application/json' },
  });
  if (!resp.ok) throw new Error(`SimplyRETS ${resp.status}`);
  return resp.json();
}

async function getListingsWithCache(cacheKey, queryParams) {
  // Check cache
  const cached = await pool.query(
    `SELECT payload, fetched_at FROM listings_cache WHERE cache_key=$1`,
    [cacheKey]
  );
  if (cached.rows.length) {
    const age = Date.now() - new Date(cached.rows[0].fetched_at).getTime();
    if (age < CACHE_TTL_MS) {
      return cached.rows[0].payload;
    }
  }

  // Fetch fresh
  const raw = await fetchFromSimplyRETS(queryParams);
  const mapped = raw.map(mapProperty);

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
    // Build a deterministic cache key from whitelisted query params
    const filtered = {};
    for (const k of ALLOWED_PARAMS) {
      if (req.query[k]) filtered[k] = req.query[k];
    }
    const cacheKey = 'listings:' + new URLSearchParams(filtered).toString();

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

    // Fetch from main listings cache or fresh
    const listingsCacheKey = 'listings:status=Active&limit=25';
    let listings;
    try {
      listings = await getListingsWithCache(listingsCacheKey, {});
    } catch {
      return res.status(404).json({ error: 'Listing not found' });
    }

    const listing = listings.find(l => String(l.mlsId) === String(req.params.mlsId));
    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    // Cache individual listing
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
