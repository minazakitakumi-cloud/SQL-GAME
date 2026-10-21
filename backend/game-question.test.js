const test = require('node:test');
const assert = require('node:assert/strict');
const {
    createQuestionPrompt,
    generateValidatedChallenge,
    generateWithFallback,
    parseGeneratedQuestion,
    validateGeneratedChallenge,
} = require('./game-question');

const challenge = () => ({
    title: 'Simple filter',
    question: 'Find IDs greater than one.',
    tables: [{
        name: 'students',
        columns: [{ name: 'id', type: 'INTEGER' }, { name: 'name', type: 'TEXT' }],
        rows: [[1, 'A'], [2, 'B'], [3, 'C'], [4, 'D']],
    }],
    hints: ['Look at IDs.', 'Use a comparison.', 'Filter IDs greater than one.'],
    solution: 'SELECT id FROM students WHERE id > 1',
    expectedOutput: { columns: ['id'], rows: [[2], [3], [4]] },
    explanation: 'The WHERE clause keeps IDs greater than one.',
});

const hardChallenge = () => ({
    ...challenge(),
    tables: [
        {
            name: 'employees',
            columns: [{ name: 'employee_id', type: 'INTEGER' }, { name: 'department_id', type: 'INTEGER' }],
            rows: [[1, 1], [2, 1], [3, 1], [4, 2], [5, 2], [6, 2], [7, 3], [8, 3]],
        },
        {
            name: 'departments',
            columns: [{ name: 'department_id', type: 'INTEGER' }, { name: 'department_name', type: 'TEXT' }],
            rows: [[1, 'Sales'], [2, 'Support'], [3, 'Design'], [4, 'Research'], [5, 'Finance'], [6, 'Legal'], [7, 'IT']],
        },
    ],
    solution: 'WITH department_counts AS (SELECT department_id, COUNT(*) AS employee_count FROM employees GROUP BY department_id) SELECT department_name, employee_count FROM departments JOIN department_counts USING (department_id)',
    expectedOutput: { columns: ['department_name', 'employee_count'], rows: [['Sales', 3], ['Support', 3], ['Design', 2]] },
});

test('keeps hard questions advanced while limiting generated dataset size', () => {
    const prompt = createQuestionPrompt('hard');
    assert.match(prompt, /exactly two related tables/);
    assert.match(prompt, /15 to 18 rows total/);
    assert.match(prompt, /five columns or fewer/);

    assert.doesNotThrow(() => validateGeneratedChallenge(hardChallenge(), 'hard'));

    const oversized = hardChallenge();
    oversized.tables[0].rows.push([9, 4], [10, 4], [11, 5], [12, 5]);
    assert.throws(() => validateGeneratedChallenge(oversized, 'hard'), /15 to 18 rows total/);

    const tooManyTables = hardChallenge();
    tooManyTables.tables.push({
        name: 'offices',
        columns: [{ name: 'office_id', type: 'INTEGER' }, { name: 'department_id', type: 'INTEGER' }],
        rows: [[1, 1], [2, 2]],
    });
    assert.throws(() => validateGeneratedChallenge(tooManyTables, 'hard'), /exactly two related tables/);
});

test('retries one malformed AI response with the same selected difficulty', async () => {
    const prompts = [];
    const result = await generateValidatedChallenge('easy', async prompt => {
        prompts.push(prompt);
        if (prompts.length === 1) {
            const error = new Error('Malformed AI JSON');
            error.retryableGeneration = true;
            throw error;
        }
        return challenge();
    });

    assert.equal(result.title, 'Simple filter');
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /easy difficulty/);
    assert.match(prompts[1], /previous response did not meet the selected difficulty/i);
});

test('falls back only when the primary provider signals a rate limit', async () => {
    let fallbackCalls = 0;
    const response = await generateWithFallback(
        async () => {
            const error = new Error('Provider quota reached');
            error.isLimit = true;
            throw error;
        },
        async () => {
            fallbackCalls += 1;
            return 'Gemini response';
        },
    );
    assert.equal(response, 'Gemini response');
    assert.equal(fallbackCalls, 1);
});

test('falls back when the primary provider returns unusable challenge output', async () => {
    let fallbackCalls = 0;
    const response = await generateWithFallback(
        async () => {
            const error = new Error('Primary response was not JSON');
            error.fallbackEligible = true;
            throw error;
        },
        async () => {
            fallbackCalls += 1;
            return 'Gemini response';
        },
    );
    assert.equal(response, 'Gemini response');
    assert.equal(fallbackCalls, 1);
});

test('does not fall back on non-quota provider errors', async () => {
    let fallbackCalls = 0;
    await assert.rejects(
        generateWithFallback(
            async () => {
                const error = new Error('Invalid Groq key');
                error.isLimit = false;
                throw error;
            },
            async () => {
                fallbackCalls += 1;
            },
        ),
        /Invalid Groq key/,
    );
    assert.equal(fallbackCalls, 0);
});

test('parses challenge JSON surrounded by model commentary and marks malformed output retryable', () => {
    assert.deepEqual(parseGeneratedQuestion('Here is the challenge:\n```json\n{"title":"ok"}\n```'), { title: 'ok' });
    assert.throws(
        () => parseGeneratedQuestion('not valid JSON'),
        error => error.retryableGeneration === true && error.status === 502,
    );
});
