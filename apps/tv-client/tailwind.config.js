/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { 950: '#05060a', 900: '#0b0c10', 850: '#101218', 800: '#151820', 750: '#1a1d27', 700: '#21252f', 600: '#2c313d' },
        fg: { DEFAULT: '#eceef3', muted: '#9aa1b2', dim: '#6b7283' },
        ember: { DEFAULT: '#ff7a45', soft: '#ff9468' },
        ok: '#3ddc97',
        warn: '#ffc857',
        bad: '#ff5d6c',
      },
      fontFamily: {
        sans: ['"Manrope Variable"', 'Manrope', 'system-ui', 'Segoe UI', 'sans-serif'],
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        rise: { from: { opacity: '0', transform: 'translateY(16px)' }, to: { opacity: '1', transform: 'none' } },
        drift: { '0%': { transform: 'scale(1.08) translate(0,0)' }, '50%': { transform: 'scale(1.14) translate(-1.5%, -1%)' }, '100%': { transform: 'scale(1.08) translate(0,0)' } },
        float: { '0%': { transform: 'translate(0,0)' }, '25%': { transform: 'translate(30vw, 20vh)' }, '50%': { transform: 'translate(10vw, 45vh)' }, '75%': { transform: 'translate(-20vw, 15vh)' }, '100%': { transform: 'translate(0,0)' } },
        'pulse-dot': { '0%,100%': { opacity: '1' }, '50%': { opacity: '.35' } },
        eq: { '0%,100%': { height: '30%' }, '50%': { height: '100%' } },
        kenburns: { from: { transform: 'scale(1.02)' }, to: { transform: 'scale(1.12) translate(-1%, -1%)' } },
        xfade: { from: { opacity: '0' }, to: { opacity: '1' } },
      },
      animation: {
        'fade-in': 'fade-in .6s ease-out',
        rise: 'rise .6s cubic-bezier(.2,.8,.2,1)',
        drift: 'drift 60s ease-in-out infinite',
        float: 'float 240s linear infinite',
        'pulse-dot': 'pulse-dot 1.6s ease-in-out infinite',
        eq: 'eq .9s ease-in-out infinite',
        kenburns: 'kenburns 30s ease-out forwards',
        xfade: 'xfade 1.6s ease-out',
      },
    },
  },
  plugins: [],
};
