# Design rubric (Sleipnyr 2)

How an agent judges a view or a change. Run the tour first, then read the
screenshots against this list. Report findings as a list. Fix only clear
inconsistencies, and ask about anything that is a taste call.

    bun tests/design.ts <preview url> <shot dir> [--report]

The tour opens 15 states at 390x844 and 1920x1080: thread list, thread,
new-thread menu, attach choice, Queue/Send, talk button, modality picker,
projects, embedded chat closed and open, Tinder, Columns and its add menu,
Blackboards list, and one board. It never sends anything. Run it against
deploy/preview.sh, not the live app: live turns change the page.

## Checked automatically (tests/design.ts)

1. No horizontal overflow (Columns' strip and the board plane are exempt).
2. Every visible button has a data-tip (on itself or an ancestor).
3. Colours are theme tokens (plugins/settings), or a token darkened or
   tinted toward black.
4. Full-width single separator lines are white 1px. Message dividers are
   grey by decision, and so are boxes (panels, cards).
5. Desktop: rows, messages, cards and the bar sit inside the centred
   reading column (--page-w 48rem; padding var(--side)).
6. Popovers share one look: black fill, white 1px border, var(--radius).
7. Text is never cut off without an ellipsis.
8. No JS errors on the page.

## Judged by eye on the screenshots

- Where am I: exactly one pink thing marks the current place (selected
  row, focused view). Pink is never decoration.
- Calm and flat: black fills, white outlines, grey for details. No
  shadows, gradients or extra colours. Agent purple and attention green
  only where they mean something.
- One action, one symbol: the same action uses the same SVG, class and
  tooltip in every view (new thread from a conversation = bent arrow).
- Icons over labels: frameless stroke icons (c-ic) in headers and bars.
  Bordered buttons are only for text choices.
- Popover anatomy: a grey .8em heading, then rows of name + grey small
  line, with surface on hover and no close button. It hangs next to its
  button (locality).
- Order: lists run oldest at the top and newest at the bottom.
- Bars: the modality bar is identical in every view, centred, with + /
  keyboard / mic toward the thumb. The embedded chat closed is exactly one
  line.
- Phone: nothing needs a precise tap under 32 px. Headers fit one line
  (ellipsis on long titles).
- Motion: anything that moves glides. Nothing teleports.

## Open questions (not fixed; the owner decides)

- The attach choice (Photos / Camera / Files) is a row of bordered buttons
  over the bar, not a popover with heading and rows like the new-thread
  and Columns add menus.
