# Televet Health — Telehealth System

A veterinary telehealth application developed as a thesis project. This is a static frontend application built with HTML, CSS, and JavaScript, featuring Firebase authentication and real-time database functionality.

## Project Status

⚠️ **Work in Progress** - This project is currently under development. Some features may be incomplete or non-functional.

## Features

- **Authentication System**: User sign-up, sign-in, and session management using Firebase Auth
- **Dashboard**: User dashboard interface
- **Appointments**: Appointment scheduling and management interface
- **Messages**: Messaging interface for communication
- **Landing Page**: Project landing page with information
- **Responsive Design**: Mobile-friendly interface

## Project Structure

```
Telehealth-System/
├── css/                  ← All stylesheets
│   ├── auth.css
│   ├── dashboard.css
│   ├── appointment.css
│   ├── messages.css
│   ├── landingpage.css
│   ├── loadingpage.css
│   ├── menu.css
│   ├── talktous.css
│   └── test.css
├── js/                   ← All JavaScript
│   ├── auth.js          (Authentication logic)
│   ├── firebase-config.js (Firebase configuration)
│   ├── menu.js
│   └── test.js
├── images/               ← Images and assets
├── scripts/              ← Python/other scripts
│   └── test.py
├── *.html                ← HTML pages
│   ├── landingpage.html  (Home page)
│   ├── auth.html         (Sign in/Sign up)
│   ├── dashboard.html
│   ├── appointment.html
│   ├── messages.html
│   ├── menu.html
│   ├── talktous.html
│   ├── loadingpage.html
│   └── test.html
└── .gitignore
```

## Technologies Used

- **Frontend**: HTML5, CSS3, JavaScript (ES6+)
- **Backend/Database**: Firebase
  - Firebase Authentication
  - Firebase Firestore
- **Version Control**: Git

## How to Run

1. Clone this repository
2. Open `landingpage.html` in a web browser to start
3. For best results, use a local development server:
   - **VS Code**: Install "Live Server" extension and click "Go Live"
   - **Python**: Run `python -m http.server 8000` in the project directory
   - **Node.js**: Run `npx serve` in the project directory

## Firebase Setup

This project uses Firebase for authentication and database services. The Firebase configuration is included in `js/firebase-config.js`. 

**Note**: Firebase API keys in the config are safe to be public as they're meant for client-side use and are protected by Firebase security rules.

## Pages Overview

| Page | Description | Status |
|------|-------------|--------|
| `landingpage.html` | Home/landing page | ✅ Implemented |
| `auth.html` | Sign in/Sign up | ✅ Implemented |
| `dashboard.html` | User dashboard | 🚧 In Progress |
| `appointment.html` | Appointment booking | 🚧 In Progress |
| `messages.html` | Messaging interface | 🚧 In Progress |
| `menu.html` | Navigation menu | ✅ Implemented |
| `talktous.html` | Contact/feedback page | 🚧 In Progress |

## Development Notes

- This is a thesis project and is actively being developed
- Some features are partially implemented
- The project structure may change as development continues

## License

This project is part of a thesis and is for educational purposes.

## Author

Thesis Project - 2026
