document.addEventListener('DOMContentLoaded', async () => {
    const elements = {
        form: document.getElementById('topicForm'),
        topic: document.getElementById('topicInput'),
        generate: document.getElementById('generateButton'),
        status: document.getElementById('practiceStatus'),
        loading: document.getElementById('loadingPanel'),
        panel: document.getElementById('exercisePanel'),
        title: document.getElementById('exerciseTitle'),
        focus: document.getElementById('topicFocus'),
        question: document.getElementById('questionText'),
        tables: document.getElementById('tableList'),
        answerForm: document.getElementById('answerForm'),
        answer: document.getElementById('sqlAnswer'),
        submit: document.getElementById('submitButton'),
        clearAnswer: document.getElementById('clearAnswerButton'),
        run: document.getElementById('runPracticeButton'),
        queryOutput: document.getElementById('practiceQueryOutput'),
        queryOutputTitle: document.getElementById('practiceQueryOutputTitle'),
        queryOutputStatus: document.getElementById('practiceQueryOutputStatus'),
        queryOutputTable: document.getElementById('practiceQueryOutputTable'),
        hintButton: document.getElementById('nextHintButton'),
        hintPanel: document.getElementById('hintPanel'),
        hintPosition: document.getElementById('hintPosition'),
        hintText: document.getElementById('hintText'),
        previousHint: document.getElementById('previousHintButton'),
        followingHint: document.getElementById('followingHintButton'),
        feedback: document.getElementById('answerFeedback'),
        feedbackTitle: document.getElementById('feedbackTitle'),
        feedbackText: document.getElementById('feedbackText'),
        explanation: document.getElementById('explanationText'),
        referencePanel: document.getElementById('referencePanel'),
        referenceSolution: document.getElementById('referenceSolution'),
        referenceOutput: document.getElementById('referenceOutput'),
        nextQuestion: document.getElementById('nextQuestionButton'),
        historyButton: document.getElementById('viewPracticeHistoryButton'),
        historyDialog: document.getElementById('practiceHistoryDialog'),
        historyClose: document.getElementById('closePracticeHistoryButton'),
        historySummary: document.getElementById('practiceHistorySummary'),
        historyList: document.getElementById('practiceHistoryList'),
    };
    const sessionKey = 'sqlQuestPracticeSession';
    const draftKey = 'sqlQuestPracticeDraft';
    const historyKey = 'sqlQuestPracticeAnswerHistory';
    let answerHistory = [];
    let practiceId = null;
    let question = null;
    let selectedHint = -1;
    let busy = false;
    let runInProgress = false;
    let sessionRefreshFailed = false;

    document.querySelectorAll('[data-practice-exit]').forEach(link => {
        link.addEventListener('click', () => {
            sessionStorage.removeItem(sessionKey);
            sessionStorage.removeItem(draftKey);
            sessionStorage.removeItem(historyKey);
            elements.form.reset();
            elements.answer.value = '';
            elements.tables.replaceChildren();
            elements.historyList.replaceChildren();
            elements.panel.hidden = true;
            elements.loading.hidden = true;
            if (elements.historyDialog.open) elements.historyDialog.close();
            answerHistory = [];
            question = null;
            practiceId = null;
        });
    });

    const setStatus = message => {
        elements.status.textContent = message || '';
        elements.status.hidden = !message;
    };

    const setBusy = (value, showLoading = true) => {
        busy = value;
        elements.generate.disabled = value;
        elements.submit.disabled = value || !question || question.completed;
        elements.clearAnswer.disabled = value || !question || question.completed;
        elements.run.disabled = value || runInProgress || !question || question.completed;
        elements.hintButton.disabled = value || !question || question.completed || question.hintsUsed >= 5;
        elements.nextQuestion.disabled = value;
        elements.loading.hidden = !value || !showLoading;
    };

    const getAccessToken = async () => {
        const { data, error } = await AppAuth.getSession();
        if (error) throw error;
        if (data.session) return data.session.access_token;

        const response = await fetch('/api/session', { credentials: 'same-origin' });
        const sessionState = await response.json().catch(() => ({}));
        if (!response.ok || !sessionState.guest) {
            window.location.replace('../login/index.html');
            throw new Error('Your session has expired. Please sign in again.');
        }
        return null;
    };

    const post = async (endpoint, body) => {
        const token = await getAccessToken();
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            credentials: 'same-origin',
            body: JSON.stringify(body),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(result.error || `Practice service returned an error (${response.status}).`);
            error.status = response.status;
            throw error;
        }
        return result;
    };

    const cellText = value => value === null ? 'NULL' : String(value);

    const clearQueryOutput = () => {
        elements.queryOutput.hidden = true;
        elements.queryOutputStatus.textContent = '';
        elements.queryOutputStatus.dataset.state = '';
        elements.queryOutputTable.replaceChildren();
    };

    const showQueryOutput = (result, title = 'Submitted query result') => {
        elements.queryOutput.hidden = false;
        elements.queryOutputTitle.textContent = title;
        elements.queryOutputTable.replaceChildren();
        if (!result || typeof result !== 'object') {
            elements.queryOutputStatus.dataset.state = 'error';
            elements.queryOutputStatus.textContent = 'Practice service did not include the query result.';
            return;
        }
        if (typeof result.error === 'string') {
            elements.queryOutputStatus.dataset.state = 'error';
            elements.queryOutputStatus.textContent = result.error;
            return;
        }
        if (!Array.isArray(result.columns) || !Array.isArray(result.rows) ||
            typeof result.truncated !== 'boolean') {
            elements.queryOutputStatus.dataset.state = 'error';
            elements.queryOutputStatus.textContent = 'Practice service returned an invalid query result.';
            return;
        }

        elements.queryOutputStatus.dataset.state = 'success';
        elements.queryOutputStatus.textContent = result.rows.length === 1
            ? '1 row returned.'
            : `${result.rows.length} rows returned.`;
        if (result.truncated) {
            elements.queryOutputStatus.textContent += ` Showing the first ${result.rows.length} rows.`;
        }
        const wrapper = document.createElement('div');
        wrapper.className = 'practice-query-output-table-wrap';
        wrapper.append(createResultTable(result.columns, result.rows));
        elements.queryOutputTable.replaceChildren(wrapper);
    };

    const createResultTable = (columns, rows) => {
        const table = document.createElement('table');
        table.className = 'sample-table';
        const head = document.createElement('thead');
        const headerRow = document.createElement('tr');
        columns.forEach(column => {
            const cell = document.createElement('th');
            cell.scope = 'col';
            cell.textContent = column;
            headerRow.append(cell);
        });
        head.append(headerRow);
        const body = document.createElement('tbody');
        rows.forEach(row => {
            const rowElement = document.createElement('tr');
            row.forEach(value => {
                const cell = document.createElement('td');
                cell.textContent = cellText(value);
                rowElement.append(cell);
            });
            body.append(rowElement);
        });
        table.append(head, body);
        return table;
    };

    const readAnswerHistory = () => {
        try {
            const saved = JSON.parse(sessionStorage.getItem(historyKey) || '[]');
            answerHistory = Array.isArray(saved) ? saved : [];
        } catch (error) {
            answerHistory = [];
            setStatus(`Unable to read saved practice history: ${error.message}`);
        }
    };

    const saveAnswerHistory = () => {
        try {
            sessionStorage.setItem(historyKey, JSON.stringify(answerHistory));
            return true;
        } catch (error) {
            setStatus(`Answer checked, but its history could not be saved in this browser: ${error.message}`);
            return false;
        }
    };

    const renderAnswerHistory = () => {
        elements.historyList.replaceChildren();
        elements.historySummary.textContent = answerHistory.length
            ? `${answerHistory.length} submitted answer${answerHistory.length === 1 ? '' : 's'} in this browser tab.`
            : 'No answers have been submitted in this practice session yet.';

        [...answerHistory].reverse().forEach((entry, index) => {
            const article = document.createElement('article');
            article.className = 'practice-history-entry';
            article.dataset.correct = String(entry.correct);

            const heading = document.createElement('div');
            heading.className = 'practice-history-entry-heading';
            const title = document.createElement('h3');
            title.textContent = `${answerHistory.length - index}. ${entry.title} · ${entry.topic}`;
            const status = document.createElement('span');
            status.className = 'practice-history-status';
            status.textContent = entry.correct ? 'Correct' : 'Incorrect';
            heading.append(title, status);

            const questionText = document.createElement('p');
            questionText.textContent = entry.question;
            const tablesHeading = document.createElement('p');
            tablesHeading.className = 'practice-history-section-label';
            tablesHeading.textContent = 'Question tables and sample data';
            const tables = document.createElement('div');
            tables.className = 'table-list practice-history-tables';
            if (Array.isArray(entry.tables)) {
                tables.replaceChildren(...entry.tables.map(makeTableCard));
            } else {
                const missingTables = document.createElement('p');
                missingTables.textContent = 'Table data was not saved for this older history entry.';
                tables.append(missingTables);
            }
            const answerLabel = document.createElement('p');
            answerLabel.className = 'practice-history-section-label';
            answerLabel.textContent = 'Submitted SQL answer';
            const sql = document.createElement('pre');
            const code = document.createElement('code');
            code.textContent = entry.sql;
            sql.append(code);
            const feedback = document.createElement('p');
            feedback.textContent = entry.feedback;
            article.append(heading, questionText, tablesHeading, tables, answerLabel, sql, feedback);
            if (entry.queryResult) {
                const resultLabel = document.createElement('p');
                resultLabel.className = 'practice-history-section-label';
                resultLabel.textContent = 'Submitted query result';
                article.append(resultLabel);
                if (typeof entry.queryResult.error === 'string') {
                    const error = document.createElement('p');
                    error.textContent = entry.queryResult.error;
                    article.append(error);
                } else if (Array.isArray(entry.queryResult.columns) && Array.isArray(entry.queryResult.rows)) {
                    const wrapper = document.createElement('div');
                    wrapper.className = 'practice-query-output-table-wrap';
                    wrapper.append(createResultTable(entry.queryResult.columns, entry.queryResult.rows));
                    article.append(wrapper);
                    if (entry.queryResult.truncated) {
                        const truncated = document.createElement('p');
                        truncated.textContent = `Showing the first ${entry.queryResult.rows.length} rows.`;
                        article.append(truncated);
                    }
                }
            }
            if (entry.explanation) {
                const explanation = document.createElement('p');
                explanation.textContent = entry.explanation;
                article.append(explanation);
            }
            elements.historyList.append(article);
        });
    };

    const makeTableCard = table => {
        const card = document.createElement('article');
        card.className = 'table-card';
        const heading = document.createElement('h4');
        heading.className = 'table-title';
        heading.textContent = table.name;
        card.append(heading);

        const schema = document.createElement('p');
        schema.className = 'schema';
        schema.textContent = `Columns: ${table.columns.map(column => `${column.name} (${column.type})`).join(', ')}`;
        card.append(schema);

        const scroll = document.createElement('div');
        scroll.className = 'table-scroll';
        const sampleTable = document.createElement('table');
        sampleTable.className = 'sample-table';
        const head = document.createElement('thead');
        const headerRow = document.createElement('tr');
        for (const column of table.columns) {
            const cell = document.createElement('th');
            cell.scope = 'col';
            cell.textContent = column.name;
            headerRow.append(cell);
        }
        head.append(headerRow);
        const body = document.createElement('tbody');
        for (const row of table.rows) {
            const rowElement = document.createElement('tr');
            for (const value of row) {
                const cell = document.createElement('td');
                cell.textContent = cellText(value);
                rowElement.append(cell);
            }
            body.append(rowElement);
        }
        sampleTable.append(head, body);
        scroll.append(sampleTable);
        card.append(scroll);
        return card;
    };

    const updateHintControls = () => {
        if (!question) return;
        elements.hintButton.textContent = `Get a hint (${5 - question.hintsUsed} left)`;
        elements.hintButton.disabled = busy || question.completed || question.hintsUsed >= 5;
        elements.previousHint.disabled = selectedHint <= 0;
        elements.followingHint.textContent =
            selectedHint >= 0 && selectedHint + 1 < question.hintsUsed ? 'Next' : 'Next hint';
        elements.followingHint.disabled = busy ||
            selectedHint < 0 ||
            (question.completed && selectedHint + 1 >= question.hintsUsed) ||
            (selectedHint + 1 >= question.hintsUsed && question.hintsUsed >= 5);
    };

    const showHint = (index, hint) => {
        selectedHint = index;
        elements.hintPanel.hidden = false;
        elements.hintPosition.textContent = `${index + 1} of 5`;
        elements.hintText.textContent = hint;
        updateHintControls();
    };

    const renderFeedback = result => {
        if (!result) {
            elements.feedback.hidden = true;
            elements.explanation.hidden = true;
            elements.referencePanel.hidden = true;
            return;
        }
        elements.feedback.hidden = false;
        elements.feedback.dataset.correct = String(result.correct);
        elements.feedbackTitle.textContent = result.correct ? 'Correct!' : 'Not quite yet';
        elements.feedbackText.textContent = result.feedback;
        elements.explanation.textContent = result.explanation || '';
        elements.explanation.hidden = !result.explanation;
        elements.referencePanel.hidden = !result.correct || !result.solution || !result.expectedOutput;
        if (!elements.referencePanel.hidden) {
            elements.referenceSolution.textContent = result.solution;
            const table = document.createElement('table');
            table.className = 'sample-table';
            const head = document.createElement('thead');
            const headingRow = document.createElement('tr');
            for (const column of result.expectedOutput.columns) {
                const cell = document.createElement('th');
                cell.scope = 'col';
                cell.textContent = column;
                headingRow.append(cell);
            }
            head.append(headingRow);
            const body = document.createElement('tbody');
            for (const row of result.expectedOutput.rows) {
                const rowElement = document.createElement('tr');
                for (const value of row) {
                    const cell = document.createElement('td');
                    cell.textContent = cellText(value);
                    rowElement.append(cell);
                }
                body.append(rowElement);
            }
            table.append(head, body);
            elements.referenceOutput.replaceChildren(table);
        }
    };

    const renderQuestion = (state, { restoring = false } = {}) => {
        question = state;
        elements.topic.value = state.topic;
        elements.title.textContent = state.exercise.title;
        elements.focus.textContent = state.exercise.topicFocus;
        elements.question.textContent = state.exercise.question;
        elements.tables.replaceChildren(...state.exercise.tables.map(makeTableCard));
        clearQueryOutput();
        elements.panel.hidden = false;
        elements.hintPanel.hidden = true;
        elements.feedback.hidden = true;
        elements.explanation.hidden = true;
        elements.nextQuestion.hidden = !state.completed;
        elements.answer.disabled = Boolean(state.completed);
        elements.submit.disabled = Boolean(state.completed);
        elements.answer.value = restoring ? sessionStorage.getItem(draftKey) || '' : '';
        selectedHint = -1;
        if (Array.isArray(state.unlockedHints) && state.unlockedHints.length) {
            const lastHintIndex = state.unlockedHints.length - 1;
            showHint(lastHintIndex, state.unlockedHints[lastHintIndex]);
        }
        renderFeedback(state.result);
        updateHintControls();
        if (!restoring) sessionStorage.removeItem(draftKey);
    };

    const generateQuestion = async (topic, next = false) => {
        if (busy) return;
        const currentId = next ? practiceId : null;
        setStatus('');
        setBusy(true);
        try {
            const state = await post('/api/practice/generate', {
                topic,
                ...(currentId ? { practiceId: currentId } : {}),
            });
            practiceId = state.practiceId;
            sessionStorage.setItem(sessionKey, practiceId);
            renderQuestion(state);
            setStatus(state.historySaveError
                ? `Practice question generated, but dashboard history was not saved: ${state.historySaveError}`
                : '');
        } catch (error) {
            setStatus(error.message);
        } finally {
            setBusy(false);
            if (question) {
                elements.submit.disabled = question.completed;
                updateHintControls();
            }
        }
    };

    elements.form.addEventListener('submit', event => {
        event.preventDefault();
        const topic = elements.topic.value.trim();
        if (topic) void generateQuestion(topic, Boolean(question && question.completed && topic === question.topic));
    });

    elements.answer.addEventListener('input', () => {
        if (practiceId) sessionStorage.setItem(draftKey, elements.answer.value);
        clearQueryOutput();
    });

    elements.clearAnswer.addEventListener('click', () => {
        elements.answer.value = '';
        if (practiceId) sessionStorage.removeItem(draftKey);
        clearQueryOutput();
        elements.answer.focus();
    });

    elements.run.addEventListener('click', async () => {
        if (!question || busy || runInProgress || question.completed) return;
        if (!elements.answer.value.trim()) {
            elements.queryOutput.hidden = false;
            elements.queryOutputStatus.dataset.state = 'error';
            elements.queryOutputStatus.textContent = 'Write a SQL query before running it.';
            elements.queryOutputTable.replaceChildren();
            elements.answer.focus();
            return;
        }

        runInProgress = true;
        elements.answer.disabled = true;
        elements.queryOutput.hidden = false;
        elements.queryOutputTitle.textContent = 'Query result';
        elements.queryOutputStatus.dataset.state = '';
        elements.queryOutputStatus.textContent = 'Running against the practice sample data…';
        elements.queryOutputTable.replaceChildren();
        setBusy(true, false);
        try {
            const result = await post('/api/practice/run', {
                practiceId,
                questionId: question.questionId,
                sql: elements.answer.value,
            });
            showQueryOutput(result, 'Query result');
        } catch (error) {
            elements.queryOutputStatus.dataset.state = 'error';
            elements.queryOutputStatus.textContent = error.message || 'Unable to run your query. Please try again.';
        } finally {
            runInProgress = false;
            elements.answer.disabled = Boolean(question?.completed);
            setBusy(false, false);
        }
    });

    elements.answerForm.addEventListener('submit', async event => {
        event.preventDefault();
        if (!question || busy) return;
        const submittedSql = elements.answer.value;
        if (!submittedSql.trim()) {
            setStatus('Write a SQL query before checking your answer.');
            elements.answer.focus();
            return;
        }
        setStatus('');
        setBusy(true);
        try {
            const result = await post('/api/practice/submit', {
                practiceId,
                questionId: question.questionId,
                sql: submittedSql,
            });
            showQueryOutput(result.queryResult);
            answerHistory.push({
                topic: question.topic,
                title: question.exercise.title,
                question: question.exercise.question,
                tables: question.exercise.tables.map(table => ({
                    name: table.name,
                    columns: table.columns.map(column => ({ name: column.name, type: column.type })),
                    rows: table.rows.map(row => [...row]),
                })),
                sql: submittedSql,
                correct: result.correct,
                feedback: result.feedback,
                queryResult: result.queryResult,
                explanation: result.explanation || '',
                answeredAt: new Date().toISOString(),
            });
            saveAnswerHistory();
            if (!result.historySaved && result.historySaveError) {
                setStatus(`Answer checked, but it was not saved to dashboard history: ${result.historySaveError}`);
            } else if (!result.historySaved) {
                setStatus('Answer checked. Sign in to include practice sessions in dashboard history.');
            }
            question.completed = result.completed;
            if (result.correct) {
                question.result = result;
                elements.answer.disabled = true;
                elements.nextQuestion.hidden = false;
                sessionStorage.removeItem(draftKey);
            }
            renderFeedback(result);
        } catch (error) {
            setStatus(error.message);
        } finally {
            setBusy(false);
            if (question) {
                elements.answer.disabled = question.completed;
                elements.submit.disabled = question.completed;
                elements.nextQuestion.hidden = !question.completed;
                updateHintControls();
            }
        }
    });

    elements.hintButton.addEventListener('click', async () => {
        if (!question || busy || question.completed || question.hintsUsed >= 5) return;
        setStatus('');
        setBusy(true);
        try {
            const result = await post('/api/practice/hint', {
                practiceId,
                questionId: question.questionId,
                hintIndex: question.hintsUsed,
            });
            question.hintsUsed = result.hintsUsed;
            question.unlockedHints.push(result.hint);
            showHint(result.hintIndex, result.hint);
        } catch (error) {
            setStatus(error.message);
        } finally {
            setBusy(false);
            updateHintControls();
        }
    });

    elements.previousHint.addEventListener('click', () => {
        const index = selectedHint - 1;
        if (!question || index < 0) return;
        showHint(index, question.unlockedHints[index]);
    });

    elements.followingHint.addEventListener('click', async () => {
        if (!question || selectedHint < 0) return;
        const nextIndex = selectedHint + 1;
        if (nextIndex < question.hintsUsed) {
            showHint(nextIndex, question.unlockedHints[nextIndex]);
        } else if (!question.completed && question.hintsUsed < 5 && !busy) {
            elements.hintButton.click();
        }
    });

    elements.nextQuestion.addEventListener('click', () => {
        if (question && question.completed) void generateQuestion(question.topic, true);
    });

    elements.historyButton.addEventListener('click', () => {
        renderAnswerHistory();
        elements.historyDialog.showModal();
    });
    elements.historyClose.addEventListener('click', () => elements.historyDialog.close());
    elements.historyDialog.addEventListener('click', event => {
        if (event.target === elements.historyDialog) elements.historyDialog.close();
    });

    const refreshPracticeSession = async () => {
        if (!practiceId || sessionRefreshFailed || busy || runInProgress ||
            document.visibilityState === 'hidden') return;
        try {
            await post('/api/practice/state', { practiceId });
        } catch (error) {
            if (error.status === 401 || error.status === 403 || error.status === 404) {
                sessionRefreshFailed = true;
                setStatus(error.message);
            }
        }
    };

    window.setInterval(refreshPracticeSession, 10 * 60 * 1000);
    window.addEventListener('focus', refreshPracticeSession);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void refreshPracticeSession();
    });

    try {
        const { data, error } = await AppAuth.getSession();
        if (error) throw error;
        let guestSession = false;
        if (!data.session) {
            const response = await fetch('/api/session', { credentials: 'same-origin' });
            const sessionState = await response.json().catch(() => ({}));
            guestSession = response.ok && Boolean(sessionState.guest);
        }
        if (!data.session && !guestSession) {
            window.location.replace('../login/index.html');
            return;
        }
        readAnswerHistory();
        practiceId = sessionStorage.getItem(sessionKey);
        if (practiceId) {
            try {
                const state = await post('/api/practice/state', { practiceId });
                renderQuestion(state, { restoring: true });
            } catch (restoreError) {
                sessionStorage.removeItem(sessionKey);
                sessionStorage.removeItem(draftKey);
                practiceId = null;
                if (!/expired|invalid|no longer/i.test(restoreError.message)) {
                    setStatus(restoreError.message);
                }
            }
        }
    } catch (error) {
        setStatus(error.message || 'Unable to check your sign-in. Please reload the page.');
    }
});
