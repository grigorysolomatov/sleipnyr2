# Design note: the modality bar (draft, for review)

Status: exploratory. Adopted as a working rule to test, not a final choice.

## Naming: the Human Context Protocol (HCP)

Exploratory, like the rest of this note. Every plugin view is its own little
interactive website with its own controls, and it also respects the Human
Context Protocol (HCP). The modality bar is the HCP: the one way a person
hands context (text, voice, images, later taps and more) to whatever view is
in front of them, and the way the view, through an agent, answers. Sleipnyr
is then a browser of plugins that all respect HCP.

What a view does to respect HCP today (contract v1, `ctx.bar`):

1. Offer a target: `ctx.bar.offer({ id, label, shown, send })`.
2. Describe: send what it shows right now and the commands it takes, as
   context for the agent (not shown to the person).
3. Act: run the agent's reply. The reply is a short answer plus one line
   per action, `@name args`; the server takes those lines out of the text
   and saves them on the reply (`actions`); the view runs them and saves
   what happened (`actionsDone`).
4. Keep a history: the view's input goes to one thread linked to the view
   (`view: <name>`), reused on every visit and never listed. The last
   request and short answer show as a thin line above the bar; a tap opens
   that thread.

The thread list is the first view besides chat to do this (open, rename,
hide, unhide). Before third-party views, HCP needs a written contract:
what a view declares, what a reply may hold, and enforced permissions.

## Core idea

Every view in the app has the same bar at the bottom: the modality bar. It
holds the ways a person can talk to the view in front of them. A view still
draws its own controls (buttons, sliders, lists); the bar is shared and is
always present.

Starting modalities: text, voice (recorded, transcribed), images (paste,
drop, picker), files (any reasonable file: PDF, text, office documents, csv,
zip, audio; same paste, drop and picker; the agent can open them). Later
candidates: camera stream, screen share, and others.

Chat stops being special. It is one view among others, the one whose content
is the conversation itself.

## Vision

Views are open-ended; modalities are fixed, because modalities belong to
the person. Anyone (including agents) may write views; every view shares the
same modalities. This constraint guides view design: a good view finds new
uses for the basic modalities, and may combine them into richer ones (speak
while dragging a slider). Clicks, discrete choices and sliders count as
modalities too, so the agent knows what was tapped when you then speak.
Agent-written views require enforced permissions and a sandbox first.

## How a view takes part

1. Describe: the view can report what it shows right now (item ids and
   basic details: open folder, selection, visible items).
2. Act: the view lists commands in its manifest (already in contract v1);
   the agent uses them.
3. Reply: the agent answers through the view, not only in words. A reply
   holds any of: text, highlights (item ids, each with a short reason) and
   notes attached to items. The view decides how to draw them.

What goes in through the bar is sent to an agent together with the view's
description and commands. The view itself does not need to understand
language.

## Rules the framework keeps

- Highlights and notes are saved items, linked to the question that made
  them, so they survive restarts.
- The agent can add and remove them; the person can always clear them with
  one control.
- How long they last is agreed between person and agent; the framework has
  no opinion. Such agreements are saved (a note on the view or agent memory).
- Every highlight has a reason, shown on hold, so answers can be checked.
- The last question and short answer show as a thin line above the bar; the
  full history is an ordinary thread linked to the view.
- Moving between views and panels uses plain controls, not the agent.

## Panels (the dashboard)

A panel is a saved item whose windows are views. The bar talks to the
focused window, marked with the "you are here" accent. Opening a window
gives it the full screen; back returns to the panel. A chat can be a window
like any other.

Focus is a level, not just a window. Views can nest (a panel holds windows,
a window may itself be a panel). The bar always talks to exactly one level:
the one you are in. Step into a window and the bar talks to that window;
step back out and it talks to the panel as a whole ("arrange the windows
alphabetically", "close all windows"). Stepping in and out uses plain
controls (tap, back). Each level has its own chat underneath it.
An outer level's description includes short summaries of its windows, so
"close the window with the PDFs" works from the panel level.

## Contract changes (v2)

- The bar moves from the chat plugin into the shell.
- Views: a plugin offers views that mount into a given box with settings.
- Extensions attach to a view instance, not to "the one chat".
- New calls: describe (view to agent) and reply (agent to view).

## Known risks

- Cost and time: looking inside many files (images, datasets) can take
  minutes and money; needs progress, a working state and a limit.
- Files on disk need stable ids, or highlights point at nothing later.
- Chat assumes it fills the screen; it needs rework to live in a window.
- The single shared bar may not suit every view. This rule is held on
  purpose for now; relax it only when a real view shows it does not fit.

## First trial

1. Move the bar into the shell; chat keeps working as before.
2. Add a read-only file browser view.
3. By voice: "which of these contain images?"; answers appear as
   highlights with reasons on hold.
