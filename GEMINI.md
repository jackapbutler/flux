# Project Instructions: Flux

Flux is a next-generation AI personal trainer that synchronizes with Strava data to provide evidence-based, personalized workout recommendations.

## 🧬 Scientific Foundation & AI Principles

Flux follows a strict set of coaching principles to ensure safety and effectiveness:

1.  **Safety First:** Prioritize injury prevention, sleep, and consistency over extreme efforts.
2.  **Evidence-Based:** Rooted in sports science (polarized training, RPE, progressive overload).
3.  **Polarized Training (80/20):** Biases toward 80% easy and 20% hard efforts.
4.  **Autoregulation:** Uses RPE (Rate of Perceived Exertion) and user context to adjust intensity dynamically.
5.  **Fatigue Management:** Monitors recent load patterns to prevent overtraining.

## 🎨 Design & Aesthetic Standards

The "High-Performance Serenity" aesthetic is core to the Flux experience:
- **Theme:** Deep Zinc (`#09090b`) & Azure Blue (`#3b82f6`).
- **Styling:** Vanilla CSS with glassmorphism, compact Bento-box layouts, and 24px border-radii.
- **Typography:** Inter (Bold for authority, Semi-bold for metrics).
- **Mobile-First:** Optimized for mobile browsers with a blurred global bottom navigation bar and large touch targets.
- **Micro-interactions:** Scale-on-tap feedback for all primary cards and buttons.

## 🛠 Tech Stack & Architecture

-   **Frontend:** React 19 (TypeScript), Vite, Vanilla CSS.
-   **Backend:** Firebase Functions v2 (Node.js 20).
-   **Database:** Firestore.
-   **AI:** Google Gemini (via `@google/generative-ai`).
-   **Integration:** Strava API (OAuth 2.0).

### Key Architectural Patterns
-   **Structured Recommendations:** Gemini output is strictly formatted as JSON and normalized before being presented to the user.
-   **Performance Profile (Digital Twin):** A persistent, evolving profile built using a Markdown-based distillation process. It covers Athlete Profile, Physicality & Constraints, Training Patterns, Readiness, and Nutrition/Recovery.
-   **Proactive Coaching:** The AI identifies trends (e.g., fatigue, plateaus) and suggests adjustments or new workouts without waiting for user requests.
-   **Global Shell Navigation:** A centralized shell provides consistent header and bottom-navigation across all states.
-   **Multi-modal Context:** Integrated voice transcription and qualitative "Nuance" logging to enrich the AI's understanding of the athlete.

## 🚀 Development Workflow

### Local Development
1.  **Emulators:** Use Firebase Emulators for local development.
    ```bash
    firebase emulators:start
    ```
2.  **Vite:** Run the dev server with `npm run dev`. Ensure `VITE_USE_EMULATORS=true` in `.env`.

### Secret Management
Secrets are managed via Firebase Functions secrets:
-   `GEMINI_API_KEY`
-   `STRAVA_CLIENT_ID`
-   `STRAVA_CLIENT_SECRET`
-   `STRAVA_STATE_SECRET`

### Deployment
-   **Hosting:** `firebase deploy --only hosting`
-   **Functions:** `firebase deploy --only functions`
