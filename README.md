# Televet Health — Telehealth System

Veterinary telehealth app (thesis project). Static HTML/CSS/JS frontend.

## Project structure

```
Telehealth-System/
├── css/              ← All stylesheets
│   ├── appointment.css
│   ├── dashboard.css
│   ├── landingpage.css
│   ├── loadingpage.css
│   ├── menu.css
│   ├── messages.css
│   ├── mockup.css
│   ├── talktous.css
│   └── test.css
├── js/               ← All JavaScript
│   ├── menu.js
│   ├── mockup.js
│   └── test.js
├── images/           ← Images (e.g. cats-out.jpg, golden-retriever.jpg)
├── scripts/          ← Python / other scripts
│   └── test.py
├── *.html            ← Pages (entry points)
│   ├── landingpage.html   (home)
│   ├── mockup.html        (sign in / sign up)
│   ├── dashboard.html
│   ├── appointment.html
│   ├── messages.html
│   ├── talktous.html
│   ├── menu.html
│   ├── loadingpage.html
│   └── test.html
└── .gitignore
```

## Quick reference

| Folder   | Use for                          |
|----------|-----------------------------------|
| **css/** | Styles for each page             |
| **js/**  | Page logic and interactivity     |
| **images/** | Photos, icons, assets        |
| **scripts/** | Python or other backend scripts |

## How to run

Open any `.html` file in a browser (e.g. `landingpage.html` or `mockup.html`). For local links to work, use a simple HTTP server if needed (e.g. VS Code “Live Server” or `python -m http.server` in the project folder).
