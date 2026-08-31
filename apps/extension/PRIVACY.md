# Compass AI — Privacy Policy

_Last updated: 2026-08-31_

Compass AI ("the extension") is a voice copilot for stockbroking sites. This
policy explains what data it handles and where that data goes. It is written to
match exactly what the extension does.

## What the extension handles

- **Your email.** Collected once during onboarding and saved to our list of users.
- **Your API keys.** You supply your own Google Gemini key, and optionally an
  Anthropic (Claude) key for web automation. They are stored locally in your
  browser (`chrome.storage.local`) so you only enter them once.
- **Microphone audio.** While a session is active, your voice is captured and
  streamed to our server, which relays it to your chosen AI provider so it can
  respond by voice.
- **Screenshots and on-page text.** While a session is active, the extension
  captures screenshots of the current tab and reads visible text on the page so
  the AI can see and reason about what you're looking at.
- **Page actions (web automation, optional).** When you enable web automation,
  the extension can click, type, and scroll on the current page on your behalf
  using the browser's debugging interface. This runs only during an active
  session and only on the tab you started it on.

## Where the data goes

- **API keys** are sent to our server only as a transient, per-session
  parameter used to make API calls to your chosen providers **on your behalf**.
  They are **not stored on our server and not written to our logs.** They remain
  in your browser between sessions.
- **Audio, screenshots, and page text** are streamed to our server for the
  duration of a session and forwarded to the AI providers (Google Gemini, and
  Anthropic if web automation is enabled) to generate responses. They are used
  only to serve your live request.
- **Your email** is sent to our server once and saved to a list of users.

## Third-party AI providers

Your requests are processed by the AI providers whose keys you supply:

- Google Gemini — see Google's privacy terms.
- Anthropic (Claude) — used only if you enable web automation; see Anthropic's
  privacy terms.

Data sent to these providers is governed by their own policies.

## Data retention

The extension does not maintain a user account or a long-term profile. Session
data (audio, screenshots, page text) is processed live and not retained by us
beyond what is needed to serve the active session. Your API keys and email stay
in your browser's local storage until you clear them or uninstall the extension.

## Your choices

- Clear your keys or email any time from the extension's side panel.
- Turn off the on-page pill without uninstalling.
- Uninstall the extension to remove all locally stored data.

## Contact

Questions about this policy: Oluwatamilore Olugbesan —
findtamilore@gmail.com
