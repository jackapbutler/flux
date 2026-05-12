# FLUX.
### Thoughtful, personalized AI training guidance.

Flux is a next-generation AI personal trainer that bridges the gap between raw data and actionable guidance. By synchronizing deeply with your Strava history and analyzing it through evidence-based training principles, Flux provides calm, professional, and highly personalized workout recommendations tailored to your specific goals and recent load.

---

## 🌟 Key Features

- **Deep Strava Integration:** Pulls comprehensive activity data including heart rate zones, power distribution, suffer scores, and device-specific metrics.
- **Scientific Coaching:** Guided by evidence-based principles like polarized training (80/20), progressive overload, and autoregulation (RPE).
- **Background AI Intelligence:** Flux builds a high-fidelity "digital twin" of your fitness persona in the background, ensuring recommendations are context-aware without bloating the UI.
- **Voice & Text Context:** Add short verbal or text notes to your sessions (e.g., "slept poorly", "knee feels tight") to allow the AI to intelligently adjust your next plan.
- **Serene Visual Experience:** A modern, airy, and inviting interface designed to feel like a supportive training partner rather than a clinical tool.

---

## 🚀 Getting Started

### 1) Prerequisites
- A Firebase project (Auth, Firestore, Hosting, Functions).
- A Strava Developer account and API application.
- A Google Gemini API key.

### 2) Configuration

#### Local Env
Copy `.env.example` → `.env` and fill in your Firebase configuration values.

#### Firebase Secrets
Set the following secrets for your Cloud Functions:

```bash
# Strava Integration
firebase functions:secrets:set STRAVA_CLIENT_ID
firebase functions:secrets:set STRAVA_CLIENT_SECRET
firebase functions:secrets:set STRAVA_STATE_SECRET

# AI Intelligence
firebase functions:secrets:set GEMINI_API_KEY
```

### 3) Installation & Development

```bash
# Install dependencies
npm install
cd functions && npm install && cd ..

# Start Firebase Emulators
firebase emulators:start

# Start Vite dev server (set VITE_USE_EMULATORS=true in .env)
npm run dev
```

---

## 🧬 Scientific Foundation

Flux isn't just a wrapper for an LLM; it's grounded in a specific set of guidance principles (defined in `functions/workout_guidance.txt`):

1. **Safety First:** Prioritizes injury prevention and sustainability over heroics.
2. **Polarized Training:** Biases toward an 80/20 split of easy and hard efforts.
3. **Autoregulation:** Uses RPE (1-10) and user context to adjust intensity dynamically.
4. **Fatigue Management:** Monitors recent load patterns to prevent overtraining and suggest recovery.

---

## 🎨 Branding & Aesthetics

Flux is built with a **Serene Blue** and **Warm Amber** palette, utilizing soft radial gradients and glassmorphism to create a space that feels "alive" and airy. 

- **Typography:** Uses a clean, bold sans-serif stack (Inter) for authority and readability.
- **Geometry:** Large border radii (`16px-20px`) and layered shadows for a soft, approachable feel.
- **Iconography:** Simplified, non-serious iconography (Emojis + Flux Spark ✦) to keep the experience human and encouraging.

---

## 🛠 Tech Stack

- **Frontend:** React, Vite, TypeScript, Vanilla CSS.
- **Backend:** Firebase Functions (v2), Firestore, Firebase Auth.
- **AI:** Google Gemini (Generative AI).
- **Integration:** Strava API (OAuth 2.0).

---

## MCP Configuration
To use the Firebase MCP server with this project, add the following to your MCP client configuration:

```json
{
  "mcpServers": {
    "firebase-mcp-server": {
      "command": "npx",
      "args": ["-y", "firebase-tools@latest", "mcp"]
    }
  }
}
```

---

## 📄 License

This project is for demonstration and personal use. Ensure you comply with Strava's API usage guidelines when deploying.

