/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './chrome-extension/popup/**/*.{html,js}',
  ],
  theme: {
    extend: {
      colors: {
        novum: {
          50: '#eef2ff',
          100: '#e0e7ff',
          200: '#c7d2fe',
          300: '#a5b4fc',
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
          800: '#3730a3',
          900: '#312e81',
        },
      },
      animation: {
        'pulse-ring': 'pulse-ring 2s infinite',
        'live-blink': 'live-blink 1.5s infinite',
      },
      keyframes: {
        'pulse-ring': {
          '0%': { boxShadow: '0 0 0 0 rgba(99,102,241,0.4)' },
          '70%': { boxShadow: '0 0 0 8px rgba(99,102,241,0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(99,102,241,0)' },
        },
        'live-blink': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        },
      },
    },
  },
  plugins: [],
};
