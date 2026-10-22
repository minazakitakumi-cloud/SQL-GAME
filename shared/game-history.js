function formatSql(sql) {
    const tokens = [];
    for (let index = 0; index < sql.length;) {
        const character = sql[index];
        const next = sql[index + 1];
        if (/\s/.test(character)) {
            index++;
            continue;
        }
        if ((character === '-' && next === '-') || (character === '/' && next === '*')) {
            const lineComment = character === '-';
            const start = index;
            index += 2;
            if (lineComment) {
                while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') index++;
            } else {
                while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) index++;
                index = Math.min(index + 2, sql.length);
            }
            tokens.push({ value: sql.slice(start, index), type: 'comment' });
            continue;
        }
        if (character === "'" || character === '"' || character === '`' || character === '[') {
            const closing = character === '[' ? ']' : character;
            const start = index++;
            while (index < sql.length) {
                if (sql[index] !== closing) {
                    index++;
                    continue;
                }
                if (sql[index + 1] === closing && character !== '[') {
                    index += 2;
                    continue;
                }
                index++;
                break;
            }
            tokens.push({ value: sql.slice(start, index), type: 'quoted' });
            continue;
        }
        if (/[A-Za-z0-9_$]/.test(character)) {
            const start = index++;
            while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index])) index++;
            tokens.push({ value: sql.slice(start, index), type: 'word' });
            continue;
        }
        if ('(),.;'.includes(character)) {
            tokens.push({ value: character, type: 'punctuation' });
            index++;
            continue;
        }
        const start = index++;
        if (/[=<>!|:+*/%-]/.test(character) && /[=<>|]/.test(sql[index] || '')) index++;
        tokens.push({ value: sql.slice(start, index), type: 'operator' });
    }

    const clauses = new Set([
        'select', 'from', 'where', 'group', 'having', 'order', 'limit', 'offset',
        'union', 'except', 'intersect', 'join', 'inner', 'left', 'right', 'full',
        'cross', 'outer', 'on', 'using', 'window', 'returning', 'when', 'else', 'end',
    ]);
    const joinModifiers = new Set(['inner', 'left', 'right', 'full', 'cross', 'outer']);
    const spacedBeforeParenthesis = new Set(['as', 'exists', 'from', 'in', 'not', 'over', 'values', 'with']);
    let output = '';
    let line = '';
    let depth = 0;
    let listDepth = -1;
    let previous = null;
    const queryParentheses = new Set();
    const flushLine = indent => {
        output += `${line.trimEnd()}\n${' '.repeat(Math.max(0, indent) * 4)}`;
        line = '';
    };
    const addSpace = () => {
        if (line && !line.endsWith(' ')) line += ' ';
    };

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        const lower = token.type === 'word' ? token.value.toLowerCase() : '';
        const previousLower = previous?.type === 'word' ? previous.value.toLowerCase() : '';
        const lineBreakBefore = token.type === 'word' && (
            (clauses.has(lower) && !(lower === 'join' && joinModifiers.has(previousLower)) &&
                !(lower === 'outer' && joinModifiers.has(previousLower))) ||
            ((lower === 'and' || lower === 'or') && previousLower !== 'by')
        );
        if (lineBreakBefore && line.trim()) {
            flushLine((lower === 'on' || lower === 'using' || lower === 'and' || lower === 'or' ||
                lower === 'when' || lower === 'else') ? depth + 1 : depth);
        }

        if (token.type === 'word' && lower === 'select' && depth > 0) {
            queryParentheses.add(depth);
        }
        if (token.type === 'word' && ['select', 'group', 'order'].includes(lower)) {
            listDepth = depth;
        } else if (token.type === 'word' && [
            'from', 'where', 'having', 'limit', 'offset', 'union', 'except', 'intersect',
            'join', 'inner', 'left', 'right', 'full', 'cross', 'on', 'using',
        ].includes(lower)) {
            listDepth = -1;
        }

        if (token.type === 'comment') {
            addSpace();
            line += token.value;
            flushLine(depth);
        } else if (token.value === '(') {
            if (previous?.type === 'word' &&
                (clauses.has(previousLower) || spacedBeforeParenthesis.has(previousLower))) addSpace();
            line += '(';
            depth++;
        } else if (token.value === ')') {
            if (queryParentheses.has(depth)) {
                flushLine(depth - 1);
                queryParentheses.delete(depth);
            }
            depth = Math.max(0, depth - 1);
            line = line.trimEnd() + ')';
        } else if (token.value === ',') {
            line = line.trimEnd() + ',';
            if (depth === listDepth) flushLine(depth + 1);
            else addSpace();
        } else if (token.value === '.') {
            line = line.trimEnd() + '.';
        } else if (token.value === ';') {
            line = line.trimEnd() + ';';
        } else if (token.type === 'operator') {
            if (token.value === '*' && (previous?.value === '(' || tokens[index + 1]?.value === ')')) {
                line += '*';
            } else {
                addSpace();
                line += `${token.value} `;
            }
        } else {
            const previousIsIdentifier = previous &&
                (previous.type === 'word' || previous.type === 'quoted' || previous.value === ')');
            if (previousIsIdentifier && token.value !== ')') addSpace();
            line += token.value;
        }
        previous = token;
    }
    output += line.trimEnd();
    return output.trim();
}

const GameHistoryRenderer = Object.freeze({
    formatSql,
    render(container, history, createTable) {
        container.replaceChildren();
        history.forEach((item, index) => {
            const article = document.createElement('article');
            article.className = 'game-history-entry';

            const heading = document.createElement('div');
            heading.className = 'game-history-entry-heading';
            const title = document.createElement('h3');
            title.textContent = `${index + 1}. ${item.title || 'Question'}`;
            const status = document.createElement('span');
            status.className = 'game-history-status';
            status.dataset.status = item.status;
            status.textContent = item.status === 'correct'
                ? 'Correct'
                : item.status === 'incorrect'
                    ? 'Incorrect'
                    : 'Unanswered';
            heading.append(title, status);

            const question = document.createElement('p');
            question.className = 'game-history-question';
            question.textContent = item.question || '';
            article.append(heading, question);

            const appendTable = (tableName, columns, rows) => {
                if (!Array.isArray(columns) || !Array.isArray(rows)) return;
                const tableHeading = document.createElement('p');
                tableHeading.className = 'game-history-attempt-label';
                tableHeading.textContent = `Table: ${tableName || 'Question data'}`;
                const wrapper = document.createElement('div');
                wrapper.className = 'game-history-table-wrap';
                wrapper.append(createTable(
                    columns.map(column => `${column.name} · ${column.type}`),
                    rows,
                    'schema-table',
                ));
                article.append(tableHeading, wrapper);
            };

            if (Array.isArray(item.tables)) {
                item.tables.forEach(table => appendTable(table.name, table.columns, table.rows));
            } else {
                appendTable(item.tableName, item.columns, item.rows);
            }

            if (!item.attempts?.length) {
                const unanswered = document.createElement('p');
                unanswered.className = 'game-history-attempt';
                unanswered.textContent = 'No answer was submitted for this question.';
                article.append(unanswered);
            } else {
                item.attempts.forEach((attempt, attemptIndex) => {
                    const attemptStatus = attempt.status === 'correct' ? 'Correct' : 'Incorrect';
                    const appendCode = (label, sql) => {
                        const codeHeading = document.createElement('p');
                        codeHeading.className = 'game-history-attempt-label';
                        codeHeading.textContent = label;
                        const code = document.createElement('pre');
                        code.className = 'game-history-code';
                        const codeContent = document.createElement('code');
                        codeContent.textContent = sql || '';
                        code.append(codeContent);
                        article.append(codeHeading, code);
                    };
                    appendCode(`Attempt ${attemptIndex + 1} · ${attemptStatus}`, attempt.submittedAnswer);
                    const feedback = document.createElement('p');
                    feedback.className = 'game-history-attempt';
                    feedback.textContent = attempt.feedback || '';
                    article.append(feedback);
                    if (attempt.queryResult && typeof attempt.queryResult === 'object') {
                        const resultHeading = document.createElement('p');
                        resultHeading.className = 'game-history-attempt-label';
                        resultHeading.textContent = 'Submitted query result';
                        article.append(resultHeading);
                        if (typeof attempt.queryResult.error === 'string') {
                            const resultError = document.createElement('p');
                            resultError.className = 'game-history-attempt';
                            resultError.textContent = attempt.queryResult.error;
                            article.append(resultError);
                        } else if (Array.isArray(attempt.queryResult.columns) &&
                            Array.isArray(attempt.queryResult.rows)) {
                            const resultTable = document.createElement('div');
                            resultTable.className = 'game-history-table-wrap';
                            resultTable.append(createTable(
                                attempt.queryResult.columns,
                                attempt.queryResult.rows,
                                'schema-table',
                            ));
                            article.append(resultTable);
                            if (attempt.queryResult.truncated) {
                                const truncated = document.createElement('p');
                                truncated.className = 'game-history-attempt';
                                truncated.textContent = `Showing the first ${attempt.queryResult.rows.length} rows.`;
                                article.append(truncated);
                            }
                        }
                    }
                    if (attempt.status === 'incorrect' && typeof attempt.correctAnswer === 'string') {
                        appendCode('Correct answer', formatSql(attempt.correctAnswer));
                    }
                });
            }
            container.append(article);
        });
    },
});

if (typeof window !== 'undefined') window.GameHistoryRenderer = GameHistoryRenderer;
if (typeof module !== 'undefined') module.exports = GameHistoryRenderer;