# Cortex Protocol — Frontend

The Cortex Protocol frontend is a **Next.js** application that provides the user interface for the Cortex Protocol marketplace. It enables users to discover, browse, and interact with Intelligence Rail assets through a modern, responsive web experience.

This repository contains only the frontend application. It communicates with the Cortex Protocol backend APIs for marketplace data, asset management, and user interactions.

---

## Features

- Modern App Router architecture with Next.js
- Responsive marketplace interface
- Asset discovery and browsing
- Type-safe development with TypeScript
- Utility-first styling with Tailwind CSS
- Ready for Stellar network integration

---

## Tech Stack

- **Next.js 16** (App Router)
- **React 19**
- **TypeScript**
- **Tailwind CSS**
- **ESLint**

---

## Prerequisites

Before getting started, ensure you have:

- Node.js 20+
- npm (or another compatible package manager)

---

## Getting Started

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

The application will be available at:

```
http://localhost:3000
```

---

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start the development server |
| `npm run build` | Create a production build |
| `npm run start` | Start the production server |
| `npm run lint` | Run ESLint |
| `npm test` | Run component tests (Jest + React Testing Library) |

---

## Project Structure

```
src/
├── app/
│   ├── layout.tsx          # Root layout and metadata
│   ├── globals.css         # Global styles
│   ├── page.tsx            # Landing page
│   └── marketplace/        # Marketplace routes
│
├── components/             # Reusable UI components
├── lib/                    # Shared utilities
├── hooks/                  # Custom React hooks
├── types/                  # TypeScript definitions
└── styles/                 # Additional styling (if applicable)
```

> The project follows the Next.js App Router conventions. New pages should be added under `src/app`, while reusable UI components should live in `src/components`.

---

## Environment Variables

Development does not require any environment variables by default.

For production deployments, configure:

```env
NEXT_PUBLIC_API_URL=https://your-backend-url
NEXT_PUBLIC_STELLAR_NETWORK=testnet
```

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_API_URL` | Base URL for the Cortex Protocol backend API |
| `NEXT_PUBLIC_STELLAR_NETWORK` | Stellar network to connect to (`testnet` or `mainnet`) |

---

## Development Workflow

1. Install dependencies.
2. Start the development server.
3. Make your changes.
4. Run linting before submitting changes.
5. Open a pull request with a clear description of the changes.

---

## Backend Integration

The frontend communicates with the Cortex Protocol backend through REST APIs exposed by the backend service.

Typical responsibilities include:

- Fetching marketplace listings
- Retrieving Intelligence Rail metadata
- Managing user interactions
- Connecting to Stellar network services

---

## Deployment

Build the application:

```bash
npm run build
```

Start the production server:

```bash
npm run start
```

The application can be deployed to platforms such as Vercel, Netlify, or any environment capable of running a Next.js application.

---

## Contributing

Contributions are welcome. Please:

- Follow the existing code style.
- Keep components reusable and well-typed.
- Run linting before opening a pull request.
- Include meaningful commit messages.

---

## License

Specify the project's license here.
