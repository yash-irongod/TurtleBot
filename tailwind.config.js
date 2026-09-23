/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        void: {
          950: '#04060A',
          900: '#080D14',
          800: '#0D141D',
          700: '#141D29',
          600: '#1C2836',
        },
        signal: {
          200: '#C7F1FF',
          300: '#93E2FF',
          400: '#5DD1FF',
          500: '#2FBFFF',
          600: '#139AD6',
          700: '#0C6E9E',
          900: '#0A2A3D',
        },
        ink: {
          100: '#EAF3F9',
          300: '#A9BAC8',
          500: '#71828F',
          700: '#46525C',
        },
        amber: {
          400: '#FBBF55',
          500: '#F5A623',
          600: '#C97F14',
        },
        critical: {
          300: '#FFA8B0',
          400: '#FF7A85',
          500: '#FF3B4E',
          600: '#D61F35',
        },
      },
      fontFamily: {
        sans: ['"Inter"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        micro: ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.08em' }],
      },
      boxShadow: {
        glow: '0 0 24px -4px rgba(47, 191, 255, 0.35)',
        'glow-sm': '0 0 12px -2px rgba(47, 191, 255, 0.4)',
        'glow-amber': '0 0 20px -4px rgba(245, 166, 35, 0.4)',
        'glow-critical': '0 0 24px -2px rgba(255, 59, 78, 0.55)',
        panel: '0 1px 0 0 rgba(255,255,255,0.04) inset, 0 0 0 1px rgba(255,255,255,0.05) inset',
      },
      backdropBlur: {
        xs: '2px',
      },
      keyframes: {
        'spin-slow': { to: { transform: 'rotate(360deg)' } },
        'pulse-soft': {
          '0%, 100%': { opacity: 1 },
          '50%': { opacity: 0.45 },
        },
        breathe: {
          '0%, 100%': { transform: 'scale(1)', opacity: 0.55 },
          '50%': { transform: 'scale(1.06)', opacity: 0.9 },
        },
        'fade-in': {
          from: { opacity: 0, transform: 'translateY(4px)' },
          to: { opacity: 1, transform: 'translateY(0)' },
        },
      },
      animation: {
        'spin-slow': 'spin-slow 8s linear infinite',
        'spin-slower': 'spin-slow 14s linear infinite',
        'pulse-soft': 'pulse-soft 2.4s ease-in-out infinite',
        breathe: 'breathe 3.6s ease-in-out infinite',
        'fade-in': 'fade-in 0.4s ease-out both',
      },
    },
  },
  plugins: [],
}
