const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const initSqlJs = require('sql.js');
const { normalizeReadOnlyQuery } = require('./practice');

const MAX_RESULT_ROWS = 100;
const MAX_RESULT_COLUMNS = 20;
const QUERY_TIMEOUT_MS = 3000;
const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

class SqlRunError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function assertQueryResultMatchesExpected(result, expected) {
    const normalizeValue = value => typeof value === 'boolean' ? Number(value) : value;
    const matches = result &&
        Array.isArray(result.columns) &&
        Array.isArray(result.rows) &&
        result.truncated === false &&
        Array.isArray(expected?.columns) &&
        Array.isArray(expected?.rows) &&
        result.columns.length === expected.columns.length &&
        result.columns.every((column, index) => column === expected.columns[index]) &&
        result.rows.length === expected.rows.length &&
        result.rows.every((row, rowIndex) =>
            Array.isArray(row) &&
            Array.isArray(expected.rows[rowIndex]) &&
            row.length === expected.rows[rowIndex].length &&
            row.every((value, columnIndex) =>
                Object.is(normalizeValue(value), normalizeValue(expected.rows[rowIndex][columnIndex]))));

    if (!matches) {
        throw new Error('The reference SQL result does not match the expected output.');
    }
}

function createDatabaseTables(database, tables) {
    if (!Array.isArray(tables) || tables.length < 1 || tables.length > 3) {
        throw new SqlRunError(500, 'The challenge sample data is unavailable.');
    }

    for (const table of tables) {
        if (!table || typeof table.name !== 'string' || !identifierPattern.test(table.name) ||
            !Array.isArray(table.columns) || table.columns.length < 1 ||
            table.columns.some(column =>
                !column || typeof column.name !== 'string' || !identifierPattern.test(column.name)) ||
            !Array.isArray(table.rows) ||
            table.rows.some(row => !Array.isArray(row) || row.length !== table.columns.length)) {
            throw new SqlRunError(500, 'The challenge sample data is invalid.');
        }

        const quoteIdentifier = identifier => `"${identifier.replace(/"/g, '""')}"`;
        const columnNames = table.columns.map(column => quoteIdentifier(column.name));
        database.run(`CREATE TABLE ${quoteIdentifier(table.name)} (${columnNames.join(', ')})`);

        const placeholders = table.columns.map(() => '?').join(', ');
        const insert = database.prepare(
            `INSERT INTO ${quoteIdentifier(table.name)} VALUES (${placeholders})`,
        );
        try {
            for (const row of table.rows) {
                insert.run(row.map(value => typeof value === 'boolean' ? Number(value) : value));
            }
        } finally {
            insert.free();
        }
    }
}

async function executeQuery(tables, query) {
    const SQL = await initSqlJs();
    const database = new SQL.Database();
    let statement;

    try {
        createDatabaseTables(database, tables);
        try {
            statement = database.prepare(query);
            const columns = statement.getColumnNames();
            if (columns.length > MAX_RESULT_COLUMNS) {
                throw new SqlRunError(400, `Queries can return up to ${MAX_RESULT_COLUMNS} columns.`);
            }

            const rows = [];
            let truncated = false;
            while (statement.step()) {
                if (rows.length === MAX_RESULT_ROWS) {
                    truncated = true;
                    break;
                }
                rows.push(statement.get());
            }
            return { columns, rows, truncated };
        } catch (error) {
            if (error instanceof SqlRunError) throw error;
            throw new SqlRunError(400, `SQL error: ${error.message}`);
        }
    } finally {
        if (statement) statement.free();
        database.close();
    }
}

function runGameSql(tables, query) {
    const normalizedQuery = normalizeReadOnlyQuery(query, 'Queries');

    return new Promise((resolve, reject) => {
        let settled = false;
        const worker = new Worker(__filename, {
            workerData: { tables, query: normalizedQuery },
        });
        const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            worker.terminate();
            reject(new SqlRunError(408, 'The query took too long to run. Try simplifying it.'));
        }, QUERY_TIMEOUT_MS);

        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (error) reject(error);
            else resolve(result);
            worker.terminate();
        };

        worker.once('message', message => {
            if (message.error) {
                finish(new SqlRunError(message.error.status, message.error.message));
            } else {
                finish(null, message.result);
            }
        });
        worker.once('error', () => {
            finish(new SqlRunError(500, 'Unable to run this query right now.'));
        });
        worker.once('exit', code => {
            if (!settled && code !== 0) {
                finish(new SqlRunError(500, 'Unable to run this query right now.'));
            }
        });
    });
}

if (isMainThread) {
    module.exports = { runGameSql, SqlRunError, assertQueryResultMatchesExpected };
} else {
    executeQuery(workerData.tables, workerData.query).then(
        result => parentPort.postMessage({ result }),
        error => parentPort.postMessage({
            error: {
                status: Number.isInteger(error.status) ? error.status : 500,
                message: error.status ? error.message : 'Unable to run this query right now.',
            },
        }),
    );
}
