// Mobile nav toggle
const navToggle = document.getElementById('navToggle');
const navMenu = document.getElementById('navMenu');

navToggle.addEventListener('click', () => {
    navToggle.classList.toggle('open');
    navMenu.classList.toggle('open');
});

// Close mobile menu when a link is clicked
navMenu.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', () => {
        navToggle.classList.remove('open');
        navMenu.classList.remove('open');
    });
});

// Highlight active nav link on scroll
const sections = document.querySelectorAll('section[id]');
const navLinks = document.querySelectorAll('.nav-link');

function highlightNav() {
    const scrollY = window.scrollY + 100;

    sections.forEach(section => {
        const top = section.offsetTop;
        const height = section.offsetHeight;
        const id = section.getAttribute('id');

        if (scrollY >= top && scrollY < top + height) {
            navLinks.forEach(link => {
                link.classList.remove('active');
                if (link.getAttribute('href') === '#' + id) {
                    link.classList.add('active');
                }
            });
        }
    });
}

window.addEventListener('scroll', highlightNav);
highlightNav();

// Dark mode toggle
const themeToggle = document.getElementById('themeToggle');
const themeIcon = document.getElementById('themeIcon');
const root = document.documentElement;

function setTheme(theme) {
    root.setAttribute('data-theme', theme);
    // ☾ moon for light mode (click to go dark), ☀ sun for dark mode (click to go light)
    themeIcon.innerHTML = theme === 'dark' ? '&#9788;' : '&#9790;';
    localStorage.setItem('theme', theme);
}

// Load saved preference or respect system preference
const saved = localStorage.getItem('theme');
if (saved) {
    setTheme(saved);
} else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
    setTheme('dark');
}

themeToggle.addEventListener('click', () => {
    const current = root.getAttribute('data-theme');
    setTheme(current === 'dark' ? 'light' : 'dark');
});
