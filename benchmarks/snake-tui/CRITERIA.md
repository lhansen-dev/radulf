# Acceptance criteria — Create snake in a Python TUI

Each line is a command that the runner executes inside the candidate's
worktree. A criterion passes when the command exits 0 (or `succeeds`).

- `python3 -c "from snake.game import SnakeGame"` exits 0
- `python3 -m pytest tests/test_game.py -v` exits 0
- `python3 -m pytest tests/test_game.py -v -k movement` exits 0
- `python3 -m pytest tests/test_game.py -v -k growth` exits 0
- `python3 -m pytest tests/test_game.py -v -k collision` exits 0
- `python3 -m pytest tests/test_game.py -v -k "game_over or gameover"` exits 0
- `python3 -c "from snake.render import draw"` exits 0
- `python3 -c "assert len(open('snake/render.py').read().splitlines()) < 80"` exits 0
- `python3 -m snake --smoke` exits 0