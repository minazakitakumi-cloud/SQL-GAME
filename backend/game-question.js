const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

const difficultySpecs = {
    easy: {
        tableCount: 'exactly one table',
        rowCount: '4 to 10 rows total',
        requirements: 'Use beginner SQL: SELECT, FROM, simple WHERE comparisons, AND/OR, ORDER BY, LIMIT, DISTINCT, or a basic COUNT/SUM/AVG/MIN/MAX. Use only a few clauses. Do not use joins, subqueries, CTEs, window functions, GROUP BY, or HAVING.',
    },
    normal: {
        tableCount: 'one to three related tables; prefer two or three when relationships help the question',
        rowCount: '8 to 20 rows total across all tables',
        requirements: 'Require an intermediate concept, such as an INNER/LEFT JOIN, GROUP BY with an aggregate, HAVING, multiple meaningful filters, sorting aggregated results, or a basic subquery. Do not make this just a simple SELECT with one filter. Avoid window functions and deeply nested subqueries.',
    },
    hard: {
        tableCount: 'exactly two related tables',
        rowCount: '15 to 18 rows total across all tables',
        requirements: 'Require advanced SQL reasoning: multiple joins, a CTE, a nested/correlated subquery, a window function (ROW_NUMBER/RANK/DENSE_RANK), complex aggregation, conditional aggregation, EXISTS/NOT EXISTS, or ranking/partitioning. The solution must visibly use an advanced construct or combine multiple joins with nontrivial aggregation/filtering. Do not label a basic SELECT-WHERE question as hard. Keep each table to five columns or fewer and use concise sample values.',
    },
};

function parseGeneratedQuestion(content) {
    const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    try {
        return JSON.parse(cleaned);
    } catch {
        for (let start = cleaned.indexOf('{'); start !== -1; start = cleaned.indexOf('{', start + 1)) {
            let depth = 0;
            let inString = false;
            let escaped = false;
            for (let index = start; index < cleaned.length; index += 1) {
                const character = cleaned[index];
                if (inString) {
                    if (escaped) escaped = false;
                    else if (character === '\\') escaped = true;
                    else if (character === '"') inString = false;
                    continue;
                }
                if (character === '"') inString = true;
                else if (character === '{') depth += 1;
                else if (character === '}') {
                    depth -= 1;
                    if (depth === 0) {
                        try {
                            return JSON.parse(cleaned.slice(start, index + 1));
                        } catch {
                            break;
                        }
                    }
                }
            }
        }
        const error = new Error('Game AI returned an invalid challenge format. Please generate a new question.');
        error.status = 502;
        error.retryableGeneration = true;
        throw error;
    }
}

function createQuestionPrompt(difficulty, retry = false) {
    const spec = difficultySpecs[difficulty];
    if (!spec) throw new Error('Choose Easy, Medium, or Hard to generate a question.');

    const messages = [
        `Create one SQL learning challenge at ${difficulty === 'normal' ? 'medium' : difficulty} difficulty.`,
        `Use ${spec.tableCount} and provide ${spec.rowCount}.`,
        spec.requirements,
        'Design the question, tables, sample records, reference query, expected result, hints, and explanation together. Every table and record must be relevant, the data must make the requested result meaningful, and primary-key/foreign-key values must agree.',
        'Use clear wording and realistic edge cases such as ties, unmatched relationships, or boundary values when they are relevant to the task.',
        'Use standard SQL constructs broadly supported by SQLite and PostgreSQL. Never use vendor-specific syntax, destructive statements, or multiple statements. Do not execute SQL.',
        'The reference query must answer the exact question from only the supplied tables and rows. Expected output column names and scalar rows must match the reference query result. Include every result row for the sample data.',
        'Provide exactly three progressive hints. The explanation should briefly describe the key reasoning.',
        'Return only valid JSON, without Markdown, using exactly this shape: {"title":"short title","question":"clear task","tables":[{"name":"identifier","columns":[{"name":"identifier","type":"SQL type"}],"rows":[["sample value"]]}],"hints":["hint 1","hint 2","hint 3"],"solution":"one read-only SELECT or WITH query without a semicolon","expectedOutput":{"columns":["result column"],"rows":[["expected value"]]},"explanation":"brief solution explanation"}. Use JSON-compatible scalar cell values only.',
    ];
    if (retry) {
        messages.unshift('The previous response did not meet the selected difficulty or challenge format. Regenerate from scratch and satisfy every constraint exactly.');
    }
    return messages.join(' ');
}

function validateGeneratedChallenge(challenge, difficulty) {
    const invalid = message => {
        const error = new Error(`Game AI returned an invalid ${difficulty} challenge: ${message}`);
        error.status = 502;
        error.retryableGeneration = true;
        throw error;
    };
    const isCellValue = value =>
        value === null ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value)) ||
        (typeof value === 'string' && value.length <= 100);

    if (!difficultySpecs[difficulty]) invalid('the selected difficulty is invalid.');
    if (!challenge || typeof challenge !== 'object' || Array.isArray(challenge) ||
        typeof challenge.title !== 'string' || !challenge.title.trim() || challenge.title.length > 100 ||
        typeof challenge.question !== 'string' || !challenge.question.trim() || challenge.question.length > 700 ||
        !Array.isArray(challenge.tables) ||
        !Array.isArray(challenge.hints) || challenge.hints.length !== 3 ||
        challenge.hints.some(hint => typeof hint !== 'string' || !hint.trim() || hint.length > 240) ||
        typeof challenge.solution !== 'string' || challenge.solution.length > 2000 ||
        !/^\s*(select|with)\b/i.test(challenge.solution) ||
        challenge.solution.includes(';') ||
        !challenge.expectedOutput || typeof challenge.expectedOutput !== 'object' ||
        !Array.isArray(challenge.expectedOutput.columns) || challenge.expectedOutput.columns.length < 1 ||
        challenge.expectedOutput.columns.some(column => typeof column !== 'string' || !column.trim() || column.length > 80) ||
        new Set(challenge.expectedOutput.columns.map(column => column.toLowerCase())).size !== challenge.expectedOutput.columns.length ||
        !Array.isArray(challenge.expectedOutput.rows) || challenge.expectedOutput.rows.length > 50 ||
        challenge.expectedOutput.rows.some(row =>
            !Array.isArray(row) || row.length !== challenge.expectedOutput.columns.length || row.some(value => !isCellValue(value))) ||
        typeof challenge.explanation !== 'string' || !challenge.explanation.trim() || challenge.explanation.length > 700) {
        invalid('required question, schema, hints, reference SQL, expected output, or explanation is missing or malformed.');
    }

    const { tables } = challenge;
    const tableBounds = difficulty === 'easy' ? [1, 1] : difficulty === 'normal' ? [1, 3] : [2, 2];
    if (tables.length < tableBounds[0] || tables.length > tableBounds[1]) {
        invalid(`it must use ${difficultySpecs[difficulty].tableCount}.`);
    }

    const tableNames = new Set();
    let totalRows = 0;
    for (const table of tables) {
        if (!table || typeof table !== 'object' || typeof table.name !== 'string' || !identifierPattern.test(table.name) ||
            tableNames.has(table.name.toLowerCase()) ||
            !Array.isArray(table.columns) || table.columns.length < 2 ||
            table.columns.length > (difficulty === 'hard' ? 5 : 8) ||
            !Array.isArray(table.rows) || table.rows.length < 2) {
            invalid('one or more table definitions are malformed.');
        }
        tableNames.add(table.name.toLowerCase());
        if (new Set(table.columns.map(column =>
            typeof column?.name === 'string' ? column.name.toLowerCase() : '')).size !== table.columns.length ||
            table.columns.some(column =>
                !column || typeof column !== 'object' ||
                !identifierPattern.test(column.name || '') ||
                typeof column.type !== 'string' || !/^[A-Za-z][A-Za-z0-9 ()_,]*$/.test(column.type) || column.type.length > 40) ||
            table.rows.some(row =>
                !Array.isArray(row) || row.length !== table.columns.length || row.some(value => !isCellValue(value)))) {
            invalid(`table ${table.name} has invalid columns or sample records.`);
        }
        totalRows += table.rows.length;
    }

    const rowBounds = difficulty === 'easy' ? [4, 10] : difficulty === 'normal' ? [8, 20] : [15, 18];
    if (totalRows < rowBounds[0] || totalRows > rowBounds[1]) {
        invalid(`it must provide ${difficultySpecs[difficulty].rowCount}.`);
    }

    const sql = challenge.solution.toLowerCase();
    const hasJoin = /\b(?:inner|left|right|full|cross)?\s*join\b/.test(sql);
    const hasGrouping = /\bgroup\s+by\b|\bhaving\b/.test(sql);
    const hasSubquery = (sql.match(/\bselect\b/g) || []).length > 1;
    const hasWindow = /\bover\s*\(|\bpartition\s+by\b|\brow_number\s*\(|\bdense_rank\s*\(|\brank\s*\(/.test(sql);
    const hasAdvanced = /\bwith\b|\bexists\b|\bnot\s+exists\b|\bcase\b/.test(sql) || hasWindow;
    const hasMultipleFilters = /\bwhere\b[\s\S]*\b(?:and|or)\b/.test(sql);
    const hasOrder = /\border\s+by\b/.test(sql);
    const hasAggregate = /\b(?:count|sum|avg|min|max)\s*\(/.test(sql);

    if (difficulty === 'easy' && (hasJoin || hasGrouping || hasSubquery || hasAdvanced)) {
        invalid('the reference SQL uses concepts above beginner difficulty.');
    }
    if (difficulty === 'normal' &&
        !(hasJoin || hasGrouping || hasSubquery || (hasMultipleFilters && (hasOrder || hasAggregate)))) {
        invalid('the reference SQL must use an intermediate concept, not only basic filtering or sorting.');
    }
    if (difficulty === 'hard' && !(hasAdvanced || hasSubquery || (hasJoin && hasGrouping))) {
        invalid('the reference SQL must use an advanced construct or combine joins with nontrivial aggregation.');
    }

    for (const table of tables) {
        if (!new RegExp(`\\b${table.name}\\b`, 'i').test(challenge.solution)) {
            invalid(`the reference SQL does not reference table ${table.name}.`);
        }
    }

    return {
        ...challenge,
        tableName: tables[0].name,
        columns: tables[0].columns,
        rows: tables[0].rows,
    };
}

async function generateValidatedChallenge(difficulty, generate, verify = async () => {}) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const retry = attempt > 0;
        const prompt = createQuestionPrompt(difficulty, retry);
        try {
            const generated = await generate(prompt);
            const challenge = validateGeneratedChallenge(generated, difficulty);
            await verify(challenge);
            return challenge;
        } catch (error) {
            if (!retry && error?.retryableGeneration) continue;
            throw error;
        }
    }
    throw new Error('Game AI could not generate a question at the selected difficulty. Please try again.');
}

async function generateWithFallback(generatePrimary, generateFallback) {
    try {
        return await generatePrimary();
    } catch (error) {
        if (!error?.isLimit && !error?.fallbackEligible) throw error;
        return generateFallback();
    }
}

module.exports = {
    createQuestionPrompt,
    generateValidatedChallenge,
    generateWithFallback,
    parseGeneratedQuestion,
    validateGeneratedChallenge,
};
