/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#08090c',
          900: '#0b0c10',
          850: '#101218',
          800: '#151820',
          750: '#1a1d27',
          700: '#21252f',
          600: '#2c313d',
          500: '#3a404e',
        },
        fg: {
          DEFAULT: '#eceef3',
          muted: '#9aa1b2',
          dim: '#6b7283',
        },
        ember: {
          DEFAULT: '#ff7a45',
          soft: '#ff9468',
          deep: '#e85d26',
        },
        ok: '#3ddc97',
        warn: '#ffc857',
        bad: '#ff5d6c',
      },
      fontFamily: {
        sans: ['"Manrope Variable"', 'Manrope', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      borderRadius: {
        '4xl': '2rem',
      },
      boxShadow: {
        glow: '0 10px 40px -10px rgba(255,122,69,0.55)',
        card: '0 1px 0 rgba(255,255,255,0.04) inset, 0 20px 40px -24px rgba(0,0,0,0.8)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'rise': { from: { opacity: '0', transform: 'translateY(10px)' }, to: { opacity: '1', transform: 'none' } },
        'sheet': { from: { transform: 'translateY(100%)' }, to: { transform: 'none' } },
        'pop': { '0%': { transform: 'scale(.96)', opacity: '0' }, '100%': { transform: 'none', opacity: '1' } },
        'pulse-dot': { '0%,100%': { opacity: '1' }, '50%': { opacity: '.35' } },
      },
      animation: {
        'fade-in': 'fade-in .2s ease-out',
        rise: 'rise .28s cubic-bezier(.2,.8,.2,1)',
        sheet: 'sheet .32s cubic-bezier(.2,.8,.2,1)',
        pop: 'pop .18s ease-out',
        'pulse-dot': 'pulse-dot 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
