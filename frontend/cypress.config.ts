import { defineConfig } from "cypress";

export default defineConfig({
  env: {
    // Expose Clerk publishable key to tests (used to compute Clerk origin for cy.origin).
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  },
  e2e: {
    baseUrl: "http://localhost:3000",
    video: false,
    screenshotOnRunFailure: true,
    specPattern: "cypress/e2e/**/*.cy.{ts,tsx,js,jsx}",
    supportFile: "cypress/support/e2e.ts",
  },
});
