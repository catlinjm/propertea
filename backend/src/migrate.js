'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { migrate } = require('./db');
migrate().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
