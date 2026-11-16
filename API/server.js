
// can i has a cookie
require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');

const zstdPromise = import('@mongodb-js/zstd');

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const MAX_SAVE_SIZE = Number(process.env.MAX_SAVE_SIZE) || 100 * 1024;
const ADMIN_TOKEN = process.env.COOKIE_ADMIN_TOKEN;

const TOKEN_SCOPES = [
    'save:read',
    'save:write',
    'save:delete'
];

// Storage format identifiers
const BASE64_MAGIC = Buffer.from('CCB1');
const TEXT_MAGIC = Buffer.from('CCT1');

if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
}

if (!ADMIN_TOKEN || ADMIN_TOKEN.length < 32) {
    throw new Error('COOKIE_ADMIN_TOKEN must be at least 32 characters');
}

const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'true'
        ? { rejectUnauthorized: true }
        : undefined
});

// --------------------------------------------------
// Database initialization
// --------------------------------------------------

async function initializeDatabase() {
    await db.query(`
        CREATE TABLE IF NOT EXISTS cookie_api_tokens (
            id BIGSERIAL PRIMARY KEY,
            username TEXT NOT NULL,
            name VARCHAR(80) NOT NULL,
            token_hash CHAR(64) NOT NULL UNIQUE,
            scopes TEXT[] NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_used_at TIMESTAMPTZ,
            expires_at TIMESTAMPTZ,
            revoked_at TIMESTAMPTZ
        );

        CREATE TABLE IF NOT EXISTS cookie_clicker_saves (
            username TEXT PRIMARY KEY,
            save_data BYTEA NOT NULL,
            save_hash CHAR(64) NOT NULL,
            revision INTEGER NOT NULL DEFAULT 1,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS cookie_tokens_username_idx
        ON cookie_api_tokens(username);
    `);

    console.log('Database initialized');
}

// --------------------------------------------------
// Utilities
// --------------------------------------------------

function hashToken(token) {
    return crypto
        .createHash('sha256')
        .update(token)
        .digest('hex');
}

function safeCompare(a, b) {
    const first = Buffer.from(a);
    const second = Buffer.from(b);

    return first.length === second.length &&
        crypto.timingSafeEqual(first, second);
}

async function compressSave(buffer) {
    const { compress } = await zstdPromise;
    return compress(buffer, 3);
}

async function decompressSave(buffer) {
    const { decompress } = await zstdPromise;
    return decompress(buffer);
}

function validUsername(username) {
    return typeof username === 'string' &&
        username.trim().length > 0 &&
        username.trim().length <= 80;
}

// --------------------------------------------------
// Save encoding
// --------------------------------------------------

// Detect Base64 saves and extract their binary payload.
//
// Cookie Clicker saves can end in !END!.
// This marker is preserved separately.

function decodeBase64Save(saveData) {
    let data = saveData;
    const hasEnd = data.endsWith('!END!');

    if (hasEnd) {
        data = data.slice(0, -5);
    }

    // Detect the Base64 alphabet.
    const urlSafe = /[-_]/.test(data);

    if (urlSafe && /[+/]/.test(data)) {
        return null;
    }

    const paddingMatch = data.match(/=*$/);
    const padding = paddingMatch[0].length;

    if (padding > 2) {
        return null;
    }

    const base64 = data.slice(0, data.length - padding);

    if (
        !/^[A-Za-z0-9]*$/.test(
            base64.replace(urlSafe ? /[-_]/g : /[+/]/g, '')
        ) ||
        (urlSafe && !/^[A-Za-z0-9_-]*$/.test(data)) ||
        (!urlSafe && !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) ||
        base64.length % 4 === 1
    ) {
        return null;
    }

    // Explicit padding must be valid.
    const expectedPadding = (4 - base64.length % 4) % 4;

    if (padding !== 0 && padding !== expectedPadding) {
        return null;
    }

    const normalized = data
        .replace(/-/g, '+')
        .replace(/_/g, '/');

    const decoded = Buffer.from(normalized, 'base64');

    // Reject non-canonical Base64.
    const canonical = decoded.toString('base64').replace(/=+$/, '');

    if (canonical !== base64.replace(/-/g, '+').replace(/_/g, '/')) {
        return null;
    }

    return {
        buffer: decoded,
        hasEnd,
        urlSafe,
        padding
    };
}

// --------------------------------------------------
// Save storage
// --------------------------------------------------

async function encodeStoredSave(saveData) {
    const decoded = decodeBase64Save(saveData);

    if (decoded) {
        // Flags:
        // Bit 0: !END! suffix
        // Bit 1: Base64URL alphabet
        // Bits 2-3: original padding count

        const flags =
            (decoded.hasEnd ? 1 : 0) |
            (decoded.urlSafe ? 2 : 0) |
            (decoded.padding << 2);

        const compressed = await compressSave(decoded.buffer);

        return Buffer.concat([
            BASE64_MAGIC,
            Buffer.from([flags]),
            compressed
        ]);
    }

    // Non-Base64 fallback.
    // Also gives us a way to store arbitrary future save formats.

    const compressed = await compressSave(
        Buffer.from(saveData, 'utf8')
    );

    return Buffer.concat([
        TEXT_MAGIC,
        compressed
    ]);
}

async function decodeStoredSave(stored) {
    // New Base64 storage format.
    if (stored.subarray(0, 4).equals(BASE64_MAGIC)) {
        const flags = stored[4];

        if (
            stored.length < 6 ||
            (flags & 0xF0) !== 0
        ) {
            throw new Error('Invalid Base64 save header');
        }

        const decompressed = await decompressSave(
            stored.subarray(5)
        );

        if (decompressed.length > MAX_SAVE_SIZE) {
            throw new Error('Decompressed save exceeds size limit');
        }

        let saveData = decompressed.toString('base64');

        // Restore original Base64 representation.
        saveData = saveData.replace(/=+$/, '');

        if (flags & 2) {
            saveData = saveData
                .replace(/\+/g, '-')
                .replace(/\//g, '_');
        }

        const padding = (flags >> 2) & 3;

        if (padding > 2) {
            throw new Error('Invalid Base64 padding metadata');
        }

        saveData += '='.repeat(padding);

        if (flags & 1) {
            saveData += '!END!';
        }

        return Buffer.from(saveData, 'utf8');
    }

    // New plain-text storage format.
    if (stored.subarray(0, 4).equals(TEXT_MAGIC)) {
        const decompressed = await decompressSave(
            stored.subarray(4)
        );

        if (decompressed.length > MAX_SAVE_SIZE) {
            throw new Error('Decompressed save exceeds size limit');
        }

        return decompressed;
    }

    // Legacy format:
    // Previous versions compressed the original UTF-8 save string
    // directly, without a storage header.

    const decompressed = await decompressSave(stored);

    if (decompressed.length > MAX_SAVE_SIZE) {
        throw new Error('Decompressed save exceeds size limit');
    }

    return decompressed;
}

// --------------------------------------------------
// Middleware
// --------------------------------------------------

app.use(express.json({
    limit: '110kb'
}));

// CORS
const allowedOrigins = (
    process.env.CORS_ORIGINS || '*'
).split(',').map(origin => origin.trim());

app.use((req, res, next) => {
    const origin = req.headers.origin;

    if (allowedOrigins.includes('*')) {
        res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (origin && allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
    }

    res.setHeader(
        'Access-Control-Allow-Methods',
        'GET, POST, PUT, DELETE, OPTIONS'
    );

    res.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type'
    );

    res.setHeader('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }

    next();
});

// API token authentication
async function cookieAuth(req, res, next) {
    try {
        const authorization = req.headers.authorization || '';
        const match = authorization.match(/^Bearer (nwc_[A-Za-z0-9_-]+)$/);

        if (!match) {
            return res.status(401).json({
                error: 'API token required'
            });
        }

        const token = match[1];

        const result = await db.query(
            `SELECT id, username, scopes
             FROM cookie_api_tokens
             WHERE token_hash = $1
             AND revoked_at IS NULL
             AND (expires_at IS NULL OR expires_at > NOW())`,
            [hashToken(token)]
        );

        const apiToken = result.rows[0];

        if (!apiToken) {
            return res.status(401).json({
                error: 'Invalid or expired API token'
            });
        }

        await db.query(
            `UPDATE cookie_api_tokens
             SET last_used_at = NOW()
             WHERE id = $1`,
            [apiToken.id]
        );

        req.user = {
            username: apiToken.username
        };

        req.cookieScopes = apiToken.scopes;
        req.cookieTokenId = apiToken.id;

        next();
    } catch (err) {
        next(err);
    }
}

// Server administrator authentication
function adminAuth(req, res, next) {
    const authorization = req.headers.authorization || '';
    const match = authorization.match(/^Bearer (.+)$/);

    if (!match || !safeCompare(match[1], ADMIN_TOKEN)) {
        return res.status(401).json({
            error: 'Administrator authentication required'
        });
    }

    next();
}

// Scope checking
function requireScope(scope) {
    return (req, res, next) => {
        if (!Array.isArray(req.cookieScopes) ||
            !req.cookieScopes.includes(scope)) {
            return res.status(403).json({
                error: 'Insufficient token permissions',
                required: scope
            });
        }

        next();
    };
}

// --------------------------------------------------
// Health
// --------------------------------------------------

app.get('/health', async (req, res) => {
    try {
        await db.query('SELECT 1');

        res.json({
            status: 'ok',
            database: 'connected'
        });
    } catch {
        res.status(503).json({
            status: 'error',
            database: 'disconnected'
        });
    }
});

// --------------------------------------------------
// GET /api/cookie/status
// --------------------------------------------------

app.get(
    '/api/cookie/status',
    cookieAuth,
    requireScope('save:read'),
    async (req, res, next) => {
        try {
            const result = await db.query(
                `SELECT revision, save_hash, updated_at
                 FROM cookie_clicker_saves
                 WHERE username = $1`,
                [req.user.username]
            );

            const save = result.rows[0];

            res.json({
                exists: !!save,
                revision: save?.revision ?? 0,
                hash: save?.save_hash ?? null,
                updatedAt: save?.updated_at ?? null
            });
        } catch (err) {
            next(err);
        }
    }
);

// --------------------------------------------------
// GET /api/cookie/save
// --------------------------------------------------

app.get(
    '/api/cookie/save',
    cookieAuth,
    requireScope('save:read'),
    async (req, res, next) => {
        try {
            const result = await db.query(
                `SELECT save_data, save_hash, revision, updated_at
                 FROM cookie_clicker_saves
                 WHERE username = $1`,
                [req.user.username]
            );

            const save = result.rows[0];

            if (!save) {
                return res.status(404).json({
                    error: 'No cloud save exists',
                    revision: 0
                });
            }

            const decompressed = await decodeStoredSave(save.save_data);

            const actualHash = crypto
                .createHash('sha256')
                .update(decompressed)
                .digest('hex');

            if (actualHash !== save.save_hash) {
                console.error(
                    `Save integrity failure: ${req.user.username}`
                );

                return res.status(500).json({
                    error: 'Save integrity check failed'
                });
            }

            res.json({
                saveData: decompressed.toString('utf8'),
                hash: save.save_hash,
                revision: save.revision,
                updatedAt: save.updated_at
            });
        } catch (err) {
            next(err);
        }
    }
);

// --------------------------------------------------
// PUT /api/cookie/save
// --------------------------------------------------

app.put(
    '/api/cookie/save',
    cookieAuth,
    requireScope('save:write'),
    async (req, res, next) => {
        try {
            const { saveData, expectedRevision } = req.body;

            if (
                typeof saveData !== 'string' ||
                !saveData.length ||
                !Number.isSafeInteger(expectedRevision) ||
                expectedRevision < 0
            ) {
                return res.status(400).json({
                    error: 'saveData and a non-negative expectedRevision are required'
                });
            }

            const buffer = Buffer.from(saveData, 'utf8');

            if (buffer.length > MAX_SAVE_SIZE) {
                return res.status(413).json({
                    error: 'Save exceeds maximum size',
                    maxSize: MAX_SAVE_SIZE
                });
            }

            // Hash the original save string, NOT its decoded contents.
            const saveHash = crypto
                .createHash('sha256')
                .update(buffer)
                .digest('hex');

            // Decode Base64 and compress the actual save payload.
            const compressed = await encodeStoredSave(saveData);

            const result = await db.query(
                `WITH updated AS (
                    UPDATE cookie_clicker_saves
                    SET save_data = $2,
                        save_hash = $3,
                        revision = revision + 1,
                        updated_at = NOW()
                    WHERE username = $1
                    AND revision = $4
                    RETURNING revision, updated_at
                ),
                inserted AS (
                    INSERT INTO cookie_clicker_saves
                        (username, save_data, save_hash, revision, updated_at)
                    SELECT $1, $2, $3, 1, NOW()
                    WHERE $4 = 0
                    AND NOT EXISTS (
                        SELECT 1
                        FROM cookie_clicker_saves
                        WHERE username = $1
                    )
                    ON CONFLICT (username) DO NOTHING
                    RETURNING revision, updated_at
                )
                SELECT * FROM updated
                UNION ALL
                SELECT * FROM inserted`,
                [
                    req.user.username,
                    compressed,
                    saveHash,
                    expectedRevision
                ]
            );

            if (!result.rows[0]) {
                const current = await db.query(
                    `SELECT revision
                     FROM cookie_clicker_saves
                     WHERE username = $1`,
                    [req.user.username]
                );

                return res.status(409).json({
                    error: 'Save revision conflict',
                    expectedRevision,
                    currentRevision: current.rows[0]?.revision ?? 0
                });
            }

            const saved = result.rows[0];

            console.log(
                `Save updated: ${req.user.username}, revision ${saved.revision}`
            );

            res.json({
                status: 'success',
                revision: saved.revision,
                hash: saveHash,
                compressedSize: compressed.length,
                originalSize: buffer.length,
                updatedAt: saved.updated_at
            });
        } catch (err) {
            next(err);
        }
    }
);

// --------------------------------------------------
// DELETE /api/cookie/save
// --------------------------------------------------

app.delete(
    '/api/cookie/save',
    cookieAuth,
    requireScope('save:delete'),
    async (req, res, next) => {
        try {
            const result = await db.query(
                `DELETE FROM cookie_clicker_saves
                 WHERE username = $1
                 RETURNING username`,
                [req.user.username]
            );

            if (!result.rowCount) {
                return res.status(404).json({
                    error: 'No cloud save exists'
                });
            }

            console.log(`Save deleted: ${req.user.username}`);

            res.json({
                status: 'success'
            });
        } catch (err) {
            next(err);
        }
    }
);

// --------------------------------------------------
// Administrator: token management
// --------------------------------------------------

// POST /api/cookie/tokens
app.post(
    '/api/cookie/tokens',
    adminAuth,
    async (req, res, next) => {
        try {
            const { username, name, scopes } = req.body;

            if (!validUsername(username)) {
                return res.status(400).json({
                    error: 'Username must be between 1 and 80 characters'
                });
            }

            if (
                typeof name !== 'string' ||
                !name.trim() ||
                name.trim().length > 80
            ) {
                return res.status(400).json({
                    error: 'Token name must be between 1 and 80 characters'
                });
            }

            const selectedScopes = scopes === undefined
                ? TOKEN_SCOPES
                : scopes;

            if (
                !Array.isArray(selectedScopes) ||
                selectedScopes.length === 0 ||
                !selectedScopes.every(scope => TOKEN_SCOPES.includes(scope)) ||
                new Set(selectedScopes).size !== selectedScopes.length
            ) {
                return res.status(400).json({
                    error: 'Invalid token scopes',
                    availableScopes: TOKEN_SCOPES
                });
            }

            const token = 'nwc_' +
                crypto.randomBytes(32).toString('base64url');

            const result = await db.query(
                `INSERT INTO cookie_api_tokens
                    (username, name, token_hash, scopes)
                 VALUES ($1, $2, $3, $4)
                 RETURNING id, username, name, scopes, created_at`,
                [
                    username.trim(),
                    name.trim(),
                    hashToken(token),
                    selectedScopes
                ]
            );

            console.log(`API token created for ${username}`);

            res.status(201).json({
                ...result.rows[0],
                token
            });
        } catch (err) {
            next(err);
        }
    }
);

// GET /api/cookie/tokens?username=...
app.get(
    '/api/cookie/tokens',
    adminAuth,
    async (req, res, next) => {
        try {
            const { username } = req.query;

            if (!validUsername(username)) {
                return res.status(400).json({
                    error: 'A valid username is required'
                });
            }

            const result = await db.query(
                `SELECT id, username, name, scopes,
                        created_at, last_used_at, expires_at, revoked_at
                 FROM cookie_api_tokens
                 WHERE username = $1
                 ORDER BY created_at DESC`,
                [username.trim()]
            );

            res.json({
                tokens: result.rows
            });
        } catch (err) {
            next(err);
        }
    }
);

// DELETE /api/cookie/tokens/:id?username=...
app.delete(
    '/api/cookie/tokens/:id',
    adminAuth,
    async (req, res, next) => {
        try {
            const { username } = req.query;

            if (!validUsername(username)) {
                return res.status(400).json({
                    error: 'A valid username is required'
                });
            }

            const result = await db.query(
                `UPDATE cookie_api_tokens
                 SET revoked_at = NOW()
                 WHERE id = $1
                 AND username = $2
                 AND revoked_at IS NULL
                 RETURNING id`,
                [req.params.id, username.trim()]
            );

            if (!result.rowCount) {
                return res.status(404).json({
                    error: 'Token not found or already revoked'
                });
            }

            res.json({
                status: 'success'
            });
        } catch (err) {
            next(err);
        }
    }
);

// --------------------------------------------------
// Error handling
// --------------------------------------------------

app.use((err, req, res, next) => {
    console.error('Server error:', err);

    if (res.headersSent) {
        return next(err);
    }

    res.status(500).json({
        error: 'Internal server error'
    });
});

// --------------------------------------------------
// Startup
// --------------------------------------------------

async function start() {
    try {
        await initializeDatabase();

        app.listen(PORT, '0.0.0.0', () => {
            console.log(`Cookie Cloud listening on port ${PORT}`);
        });
    } catch (err) {
        console.error('Failed to start Cookie Cloud:', err);
        process.exit(1);
    }
}

start();
