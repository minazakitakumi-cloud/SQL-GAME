(() => {
    const dialog = document.getElementById('historyDialog');
    const openButton = document.getElementById('historyButton');
    const closeButton = document.getElementById('historyClose');
    const listScreen = document.getElementById('historyListScreen');
    const detailScreen = document.getElementById('historyDetailScreen');
    const status = document.getElementById('historyStatus');
    const error = document.getElementById('historyError');
    const guestMessage = document.getElementById('historyGuest');
    const emptyMessage = document.getElementById('historyEmpty');
    const gamesContainer = document.getElementById('historyGames');
    const backButton = document.getElementById('historyBack');
    const detailTitle = document.getElementById('historyDetailTitle');
    const detailSummary = document.getElementById('historyDetailSummary');
    const detailStatus = document.getElementById('historyDetailStatus');
    const detailError = document.getElementById('historyDetailError');
    const detailList = document.getElementById('historyDetailList');
    const difficultyNames = { easy: 'Easy', normal: 'Medium', hard: 'Hard', practice: 'Practice' };
    let dialogOpener = null;
    let selectedGameButton = null;

    const createTable = (columns, rows, className) => {
        const table = document.createElement('table');
        table.className = className;
        const head = document.createElement('thead');
        const headerRow = document.createElement('tr');
        columns.forEach(column => {
            const cell = document.createElement('th');
            cell.scope = 'col';
            cell.textContent = String(column);
            headerRow.append(cell);
        });
        head.append(headerRow);
        table.append(head);

        const body = document.createElement('tbody');
        rows.forEach(row => {
            const tableRow = document.createElement('tr');
            row.forEach(value => {
                const cell = document.createElement('td');
                cell.textContent = value === null ? 'NULL' : String(value);
                tableRow.append(cell);
            });
            body.append(tableRow);
        });
        table.append(body);
        return table;
    };

    const formatFinishedAt = value => {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleString();
    };

    const setListState = state => {
        status.hidden = state !== 'loading';
        status.textContent = state === 'loading' ? 'Loading your games…' : '';
        error.hidden = state !== 'error';
        guestMessage.hidden = state !== 'guest';
        emptyMessage.hidden = state !== 'empty';
        gamesContainer.hidden = state !== 'games';
        if (state !== 'error') error.textContent = '';
    };

    const renderGames = games => {
        gamesContainer.replaceChildren();
        games.forEach(game => {
            const button = document.createElement('button');
            button.className = 'history-game-button';
            button.type = 'button';
            const difficulty = document.createElement('span');
            difficulty.className = 'history-game-difficulty';
            difficulty.textContent = difficultyNames[game.difficulty] || 'SQL Quest';
            const score = document.createElement('strong');
            score.className = 'history-game-score';
            score.textContent = game.difficulty === 'practice'
                ? 'Practice mode'
                : `${Number(game.final_score) || 0} points`;
            const finished = document.createElement('time');
            finished.className = 'history-game-finished';
            finished.dateTime = typeof game.finished_at === 'string' ? game.finished_at : '';
            finished.textContent = formatFinishedAt(game.finished_at);
            const action = document.createElement('span');
            action.className = 'history-game-action';
            action.setAttribute('aria-hidden', 'true');
            action.textContent = 'View →';
            button.setAttribute('aria-label', `${difficulty.textContent}, ${score.textContent}, activity ${finished.textContent}. View details.`);
            button.append(difficulty, score, finished, action);
            button.addEventListener('click', () => openGame(game, button));
            gamesContainer.append(button);
        });
        setListState(games.length ? 'games' : 'empty');
    };

    const loadGames = async () => {
        setListState('loading');
        gamesContainer.replaceChildren();
        try {
            const { data, error: sessionError } = await AppAuth.getSession();
            if (sessionError) throw sessionError;
            const response = await fetch('/api/game/history', {
                headers: data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {},
                credentials: 'same-origin',
                cache: 'no-store',
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || `History request failed (${response.status}).`);
            if (result.guest) {
                setListState('guest');
                return;
            }
            if (!Array.isArray(result.games)) throw new Error('Game history returned invalid data.');
            renderGames(result.games);
        } catch (loadError) {
            setListState('error');
            error.textContent = loadError.message || 'Unable to load game history. Please try again.';
        }
    };

    const openGame = async (game, opener) => {
        selectedGameButton = opener;
        listScreen.hidden = true;
        detailScreen.hidden = false;
        detailTitle.textContent = game.difficulty === 'practice'
            ? 'Practice session'
            : `${difficultyNames[game.difficulty] || 'SQL Quest'} game`;
        detailSummary.textContent = game.difficulty === 'practice'
            ? `Practice mode · Activity ${formatFinishedAt(game.finished_at)}`
            : `${Number(game.final_score) || 0} points · Activity ${formatFinishedAt(game.finished_at)}`;
        detailStatus.textContent = 'Loading questions and attempts…';
        detailStatus.hidden = false;
        detailError.hidden = true;
        detailList.replaceChildren();
        backButton.focus();

        try {
            const { data, error: sessionError } = await AppAuth.getSession();
            if (sessionError) throw sessionError;
            const response = await fetch(`/api/game/history/${encodeURIComponent(game.id)}`, {
                headers: data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {},
                credentials: 'same-origin',
                cache: 'no-store',
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || `History request failed (${response.status}).`);
            if (result.guest) {
                throw new Error('Sign in to save and view your game history.');
            }
            if (!Array.isArray(result.history)) throw new Error('This game history is incomplete.');
            GameHistoryRenderer.render(detailList, result.history, createTable);
            detailSummary.textContent += game.difficulty === 'practice'
                ? ` · ${result.history.length} practice questions`
                : ` · ${result.history.length} questions`;
            detailStatus.hidden = true;
        } catch (loadError) {
            detailStatus.hidden = true;
            detailError.textContent = loadError.message || 'Unable to load this game. Please try again.';
            detailError.hidden = false;
        }
    };

    const returnToList = () => {
        detailScreen.hidden = true;
        listScreen.hidden = false;
        selectedGameButton?.focus();
    };

    openButton.addEventListener('click', () => {
        if (dialog.open) return;
        dialogOpener = openButton;
        listScreen.hidden = false;
        detailScreen.hidden = true;
        dialog.showModal();
        loadGames();
    });
    closeButton.addEventListener('click', () => dialog.close());
    backButton.addEventListener('click', returnToList);
    dialog.addEventListener('click', event => {
        if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener('close', () => {
        dialogOpener?.focus();
        dialogOpener = null;
        selectedGameButton = null;
    });
})();