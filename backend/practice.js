const { randomUUID } = require('node:crypto');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

class PracticeError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function normalizeReadOnlyQuery(query, context = 'Practice answers') {
    if (typeof query !== 'string' || !query.trim() || query.length > 4000) {
        throw new PracticeError(400, 'Enter a SQL answer up to 4,000 characters long.');
    }

    let normalized = '';
    let analysis = '';
    let quote = '';
    let lineComment = false;
    let blockComment = false;
    let semicolonCount = 0;
    let semicolonPosition = -1;

    for (let index = 0; index < query.length; index++) {
        const character = query[index];
        const next = query[index + 1];

        if (lineComment) {
            const replacement = character === '\n' || character === '\r' ? character : ' ';
            normalized += replacement;
            analysis += replacement;
            if (character === '\n' || character === '\r') lineComment = false;
            continue;
        }
        if (blockComment) {
            if (character === '*' && next === '/') {
                normalized += '  ';
                analysis += '  ';
                index++;
                blockComment = false;
            } else {
                const replacement = character === '\n' || character === '\r' ? character : ' ';
                normalized += replacement;
                analysis += replacement;
            }
            continue;
        }
        if (quote) {
            normalized += character;
            analysis += ' ';
            if (character === quote) {
                if (next === quote) {
                    normalized += next;
                    analysis += ' ';
                    index++;
                } else {
                    quote = '';
                }
            }
            continue;
        }
        if (character === '-' && next === '-') {
            normalized += '  ';
            analysis += '  ';
            index++;
            lineComment = true;
            continue;
        }
        if (character === '/' && next === '*') {
            normalized += '  ';
            analysis += '  ';
            index++;
            blockComment = true;
            continue;
        }
        if (character === "'" || character === '"' || character === '`' || character === '[') {
            quote = character === '[' ? ']' : character;
            normalized += character;
            analysis += ' ';
            continue;
        }
        if (character === ';') {
            semicolonCount++;
            semicolonPosition = normalized.length;
        }
        normalized += character;
        analysis += character;
    }

    if (blockComment || quote) {
        throw new PracticeError(400, 'Finish the SQL comment or quoted value before checking your answer.');
    }
    const code = analysis.trim();
    const codeWithoutFinalSemicolon = code.endsWith(';') ? code.slice(0, -1).trimEnd() : code;
    if (!/^(select|with)\b/i.test(codeWithoutFinalSemicolon) ||
        semicolonCount > 1 ||
        (semicolonCount === 1 && analysis.slice(semicolonPosition + 1).trim() !== '') ||
        /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|copy|call|execute)\b/i.test(codeWithoutFinalSemicolon)) {
        throw new PracticeError(400, `${context} must be a single read-only SELECT or WITH query.`);
    }

    let result = normalized.trim();
    if (result.endsWith(';')) result = result.slice(0, -1).trimEnd();
    return result;
}

function validatePracticeExercise(exercise) {
    const isCellValue = value =>
        value === null ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value)) ||
        (typeof value === 'string' && value.length <= 100);
    const isResultSet = result =>
        result && typeof result === 'object' &&
        Array.isArray(result.columns) && result.columns.length >= 1 &&
        result.columns.length <= 8 &&
        result.columns.every(column => typeof column === 'string' && column.trim().length > 0 && column.trim().length <= 60) &&
        Array.isArray(result.rows) && result.rows.length <= 12 &&
        result.rows.every(row =>
            Array.isArray(row) && row.length === result.columns.length && row.every(isCellValue));

    if (!exercise || typeof exercise !== 'object' ||
        typeof exercise.title !== 'string' || !exercise.title.trim() || exercise.title.length > 100 ||
        typeof exercise.question !== 'string' || !exercise.question.trim() || exercise.question.length > 900 ||
        typeof exercise.topicFocus !== 'string' || !exercise.topicFocus.trim() || exercise.topicFocus.length > 240 ||
        !Array.isArray(exercise.tables) || exercise.tables.length < 1 || exercise.tables.length > 3 ||
        !Array.isArray(exercise.hints) || exercise.hints.length !== 5 ||
        exercise.hints.some(hint => typeof hint !== 'string' || !hint.trim() || hint.length > 240) ||
        typeof exercise.solution !== 'string' || exercise.solution.length > 2500 ||
        !/^\s*(select|with)\b/i.test(exercise.solution) || exercise.solution.includes(';') ||
        /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|copy|call|execute)\b/i.test(exercise.solution) ||
        typeof exercise.explanation !== 'string' || !exercise.explanation.trim() || exercise.explanation.length > 600 ||
        !isResultSet(exercise.expectedOutput)) {
        throw new PracticeError(502, 'Practice AI returned an incomplete exercise. Please try generating it again.');
    }

    const tableNames = new Set();
    for (const table of exercise.tables) {
        if (!table || typeof table !== 'object' ||
            typeof table.name !== 'string' || !identifierPattern.test(table.name) ||
            tableNames.has(table.name.toLowerCase()) ||
            !Array.isArray(table.columns) || table.columns.length < 2 || table.columns.length > 8 ||
            table.columns.some(column =>
                !column || typeof column !== 'object' ||
                typeof column.name !== 'string' || !identifierPattern.test(column.name) ||
                typeof column.type !== 'string' || !/^[A-Za-z][A-Za-z0-9 ()_,]*$/.test(column.type) ||
                column.type.length > 40) ||
            new Set(table.columns.map(column => column.name.toLowerCase())).size !== table.columns.length ||
            !Array.isArray(table.rows) || table.rows.length < 2 || table.rows.length > 12 ||
            table.rows.some(row =>
                !Array.isArray(row) || row.length !== table.columns.length || row.some(value => !isCellValue(value)))) {
            throw new PracticeError(502, 'Practice AI returned invalid tables or sample data. Please try again.');
        }
        tableNames.add(table.name.toLowerCase());
    }

    return exercise;
}

function createPracticeManager({
    generateExercise,
    evaluateAnswer,
    runQuery,
    verifyExercise = async () => {},
    now = Date.now,
    lifetime = 24 * 60 * 60 * 1000,
    generationLimit = 10,
    generationWindow = 60 * 1000,
}) {
    const sessions = new Map();
    const startingUsers = new Set();
    const generationTimes = new Map();

    const getSession = (practiceId, userId) => {
        const session = sessions.get(practiceId);
        if (!session || session.expiresAt <= now()) {
            sessions.delete(practiceId);
            throw new PracticeError(404, 'This practice session expired. Start a new practice question.');
        }
        if (session.userId !== userId) {
            throw new PracticeError(403, 'This practice session belongs to another signed-in player.');
        }
        session.expiresAt = now() + lifetime;
        return session;
    };

    const publicExercise = exercise => ({
        title: exercise.title,
        question: exercise.question,
        topicFocus: exercise.topicFocus,
        tables: exercise.tables,
    });

    const publicState = session => ({
        practiceId: session.id,
        questionId: session.questionId,
        topic: session.topic,
        exercise: publicExercise(session.exercise),
        hintsUsed: session.hintsUsed,
        unlockedHints: session.exercise.hints.slice(0, session.hintsUsed),
        completed: session.completed,
        result: session.completedResult || undefined,
    });

    const ensureHistoryEntry = session => {
        let historyEntry = session.history.find(item => item.questionId === session.questionId);
        if (historyEntry) return historyEntry;

        const tables = session.exercise.tables;
        historyEntry = {
            questionId: session.questionId,
            difficulty: 'practice',
            title: session.exercise.title,
            question: session.exercise.question,
            tableName: tables[0].name,
            columns: tables[0].columns.map(column => ({ ...column })),
            rows: tables[0].rows.map(row => [...row]),
            tables: tables.map(table => ({
                name: table.name,
                columns: table.columns.map(column => ({ ...column })),
                rows: table.rows.map(row => [...row]),
            })),
            status: 'unanswered',
            attempts: [],
        };
        session.history.push(historyEntry);
        return historyEntry;
    };

    const prune = () => {
        const currentTime = now();
        for (const [id, session] of sessions) {
            if (session.expiresAt <= currentTime) sessions.delete(id);
        }
        for (const [userId, timestamps] of generationTimes) {
            const recent = timestamps.filter(timestamp => currentTime - timestamp < generationWindow);
            if (recent.length) generationTimes.set(userId, recent);
            else generationTimes.delete(userId);
        }
        while (sessions.size >= 1000) sessions.delete(sessions.keys().next().value);
    };

    return Object.freeze({
        async generate(userId, topic, practiceId) {
            if (typeof topic !== 'string' || !topic.trim() || topic.trim().length > 120) {
                throw new PracticeError(400, 'Enter a SQL topic up to 120 characters long.');
            }
            const normalizedTopic = topic.trim();
            prune();
            if ((generationTimes.get(userId) || []).length >= generationLimit) {
                throw new PracticeError(429, 'You have generated several practice questions recently. Please wait a minute and try again.');
            }
            let session;
            let isNewSession = false;
            if (practiceId === undefined || practiceId === null || practiceId === '') {
                if (startingUsers.has(userId)) {
                    throw new PracticeError(409, 'A practice question is already being generated.');
                }
                startingUsers.add(userId);
                const id = randomUUID();
                isNewSession = true;
                session = {
                    id,
                    userId,
                    topic: normalizedTopic,
                    expiresAt: now() + lifetime,
                    questionId: null,
                    exercise: null,
                    hintsUsed: 0,
                    completed: false,
                    generating: false,
                    history: [],
                };
                sessions.set(id, session);
            } else {
                if (typeof practiceId !== 'string' || !UUID_PATTERN.test(practiceId)) {
                    throw new PracticeError(400, 'This practice session ID is invalid. Start a new practice session.');
                }
                session = getSession(practiceId, userId);
                if (session.generating) {
                    throw new PracticeError(409, 'A practice question is already being generated.');
                }
                if (!session.completed) {
                    throw new PracticeError(409, 'Complete the current practice question before generating another.');
                }
                if (normalizedTopic !== session.topic) {
                    throw new PracticeError(400, 'Change the topic by starting a new practice session.');
                }
            }

            session.generating = true;
            try {
                let exercise;
                for (let attempt = 0; attempt < 2; attempt += 1) {
                    const generatedExercise = await generateExercise(normalizedTopic, attempt > 0);
                    try {
                        exercise = validatePracticeExercise(generatedExercise);
                        await verifyExercise(exercise);
                        break;
                    } catch (error) {
                        if (attempt === 1 || error.status !== 502) throw error;
                    }
                }
                session.questionId = randomUUID();
                session.exercise = exercise;
                session.hintsUsed = 0;
                session.completed = false;
                session.completedResult = null;
                session.expiresAt = now() + lifetime;
                ensureHistoryEntry(session);
                const timestamps = generationTimes.get(userId) || [];
                timestamps.push(now());
                generationTimes.set(userId, timestamps);
                return publicState(session);
            } catch (error) {
                if (!session.exercise) sessions.delete(session.id);
                throw error;
            } finally {
                session.generating = false;
                if (isNewSession) startingUsers.delete(userId);
            }
        },

        getState(userId, practiceId) {
            if (typeof practiceId !== 'string' || !UUID_PATTERN.test(practiceId)) {
                throw new PracticeError(400, 'This practice session ID is invalid.');
            }
            return publicState(getSession(practiceId, userId));
        },

        async submit(userId, practiceId, questionId, sql) {
            const session = getSession(practiceId, userId);
            if (typeof questionId !== 'string' || questionId !== session.questionId) {
                throw new PracticeError(403, 'This answer does not belong to the current practice question.');
            }
            const normalizedSql = normalizeReadOnlyQuery(sql);
            if (session.completed) {
                throw new PracticeError(409, 'This practice question is already complete. Generate another one.');
            }
            if (session.checking) {
                throw new PracticeError(409, 'This answer is already being checked.');
            }
            if (session.running) {
                throw new PracticeError(409, 'Wait until your query has finished running before checking your answer.');
            }

            session.checking = true;
            try {
                const result = await evaluateAnswer(session.exercise, normalizedSql);
                if (!result || typeof result.correct !== 'boolean' ||
                    typeof result.feedback !== 'string' || !result.feedback.trim() || result.feedback.length > 300) {
                    throw new PracticeError(502, 'Practice AI returned invalid answer feedback. Please try again.');
                }
                const response = {
                    correct: result.correct,
                    feedback: result.feedback,
                    explanation: result.correct ? session.exercise.explanation : undefined,
                    completed: session.completed,
                };
                if (result.correct) {
                    session.completed = true;
                    response.completed = true;
                    response.solution = session.exercise.solution;
                    response.expectedOutput = session.exercise.expectedOutput;
                    session.completedResult = response;
                }
                try {
                    response.queryResult = await runQuery(session.exercise.tables, sql);
                } catch (error) {
                    response.queryResult = {
                        error: error.message || 'Unable to run your submitted query.',
                    };
                }
                if (session.completed) session.completedResult.queryResult = response.queryResult;
                const historyEntry = ensureHistoryEntry(session);
                const attempt = {
                    submittedAnswer: sql,
                    status: result.correct ? 'correct' : 'incorrect',
                    feedback: result.feedback,
                    queryResult: response.queryResult,
                };
                if (!result.correct) attempt.correctAnswer = session.exercise.solution;
                historyEntry.attempts.push(attempt);
                historyEntry.status = attempt.status;
                if (!result.correct) historyEntry.correctAnswer = session.exercise.solution;
                session.lastAnsweredAt = new Date(now()).toISOString();
                return response;
            } finally {
                session.checking = false;
            }
        },

        getRecord(userId, practiceId) {
            const session = getSession(practiceId, userId);
            return {
                id: session.id,
                userId: session.userId,
                difficulty: 'practice',
                score: 0,
                history: session.history,
                finishedAt: session.lastAnsweredAt,
            };
        },

        async run(userId, practiceId, questionId, sql) {
            const session = getSession(practiceId, userId);
            if (typeof questionId !== 'string' || questionId !== session.questionId) {
                throw new PracticeError(403, 'This query does not belong to the current practice question.');
            }
            if (session.completed) {
                throw new PracticeError(409, 'This practice question is complete. Generate another one.');
            }
            if (session.checking || session.generating || session.running) {
                throw new PracticeError(409, 'Wait for the current practice request to finish before running a query.');
            }

            session.running = true;
            try {
                return await runQuery(session.exercise.tables, sql);
            } finally {
                session.running = false;
            }
        },

        hint(userId, practiceId, questionId, hintIndex) {
            const session = getSession(practiceId, userId);
            if (questionId !== session.questionId) {
                throw new PracticeError(403, 'This hint does not belong to the current practice question.');
            }
            if (!Number.isInteger(hintIndex) || hintIndex < 0 || hintIndex >= 5) {
                throw new PracticeError(400, 'Choose a valid practice hint.');
            }
            if (session.completed) {
                throw new PracticeError(409, 'This practice question is complete.');
            }
            if (session.checking || session.generating) {
                throw new PracticeError(409, 'Wait for the current practice request to finish.');
            }
            if (session.running) {
                throw new PracticeError(409, 'Wait until your query has finished running before using a hint.');
            }
            if (hintIndex > session.hintsUsed) {
                throw new PracticeError(409, 'Unlock practice hints in order.');
            }
            if (hintIndex === session.hintsUsed) session.hintsUsed++;
            return {
                hintIndex,
                hint: session.exercise.hints[hintIndex],
                hintsUsed: session.hintsUsed,
                hintsRemaining: 5 - session.hintsUsed,
            };
        },
    });
}

module.exports = { createPracticeManager, validatePracticeExercise, normalizeReadOnlyQuery, PracticeError };
