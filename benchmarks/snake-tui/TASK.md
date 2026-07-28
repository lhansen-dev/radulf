Create snake in a Python TUI

Build a playable Snake game inside a Python terminal UI (TUI). The game must
use the `curses` module for the terminal interface and be structured as a
Python package `snake/` with the following files and contracts:

### `snake/game.py` — headless game logic

A module containing a `SnakeGame` class with no terminal or curses dependency.
The class must expose:

- `__init__(self, width: int, height: int)` — initialises a new game on a
  board of the given dimensions. The snake starts at the centre, moving right
  (dx=1, dy=0). One food item is placed at a random non-snake position.
- `change_direction(self, dx: int, dy: int)` — queues the next direction for
  the next tick. Only perpendicular turns are accepted (no 180-degree
  reversal). Equivalent names such as `set_direction` or `turn` are fine.
- `step(self)` or `tick(self)` — advances the game by one frame. Moves the
  snake head in the current direction, checks wall collision, self collision,
  and food consumption. Grows the snake (appends to tail) when food is
  consumed and spawns new food. Raises or sets `game_over=True` on collision.
- Readable state attributes:
  - `snake` — list of (x, y) tuples for the snake body, head first.
  - `food` — (x, y) tuple for the current food position.
  - `score` — integer count of food items eaten.
  - `game_over` — boolean, `True` when the game has ended (wall or self
    collision).

### `snake/render.py` — thin terminal rendering

A module with a single function `draw(game, screen)` (or equivalent) that
renders the current `SnakeGame` state onto a curses `window` object. This file
must contain **no game logic** — only presentation. It should be kept short
(under 80 lines).

### `snake/__main__.py` — entry point

A module that runs the full curses TUI when invoked as `python3 -m snake`.
It must also accept a `--smoke` flag: when `--smoke` is passed, the program
runs a few headless `step()` calls, prints nothing, and exits 0 without
requiring a terminal or curses initialisation.

### `tests/test_game.py` — pytest unit tests

Tests using `pytest` with test names that clearly cover the following areas:

- `test_movement` — snake moves in the correct direction each tick.
- `test_growth` — snake grows when it eats food.
- `test_wall_collision` — game ends when the snake hits a wall.
- `test_self_collision` — game ends when the snake hits itself.
- `test_game_over` — the `game_over` flag is set correctly on collision.

### `requirements.txt`

A text file containing a single line: `pytest`.

### Constraints

- The game logic in `game.py` must be fully testable without a terminal, a
  curses import, or a TTY.
- `render.py` must import `curses` only for the `window` type hint and must
  contain no game-state mutation.
- `__main__.py` must handle `--smoke` before any curses setup so it works in
  headless/CI environments.
- All tests must pass with `python3 -m pytest tests/test_game.py -v`.