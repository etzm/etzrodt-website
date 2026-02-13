// Mobile nav toggle
const navToggle = document.getElementById('navToggle');
const navMenu = document.getElementById('navMenu');

navToggle.addEventListener('click', () => {
    navToggle.classList.toggle('open');
    navMenu.classList.toggle('open');
});

// Close mobile menu when a nav link (not dropdown trigger) is clicked
navMenu.querySelectorAll('.nav-link:not(.nav-link-dropdown), .dropdown-item').forEach(link => {
    link.addEventListener('click', () => {
        navToggle.classList.remove('open');
        navMenu.classList.remove('open');
        // Also close any open dropdowns
        document.querySelectorAll('.nav-dropdown').forEach(d => d.classList.remove('open'));
    });
});

// Mobile dropdown toggle
const navDropdown = document.querySelector('.nav-dropdown');
const dropdownTrigger = document.querySelector('.nav-link-dropdown');

if (dropdownTrigger) {
    dropdownTrigger.addEventListener('click', (e) => {
        // On mobile, toggle dropdown instead of navigating
        if (window.innerWidth <= 768) {
            e.preventDefault();
            navDropdown.classList.toggle('open');
        }
    });
}

// Highlight active nav link on scroll (only on homepage)
const sections = document.querySelectorAll('section[id]');
const navLinks = document.querySelectorAll('.nav-link');
const isHomepage = window.location.pathname === '/' || window.location.pathname === '/index.html' || window.location.pathname === '';

function highlightNav() {
    if (!isHomepage) {
        // On publications page, highlight publications
        navLinks.forEach(link => {
            link.classList.remove('active');
            if (link.classList.contains('nav-link-dropdown')) {
                link.classList.add('active');
            }
        });
        return;
    }

    const scrollY = window.scrollY + 100;

    sections.forEach(section => {
        const top = section.offsetTop;
        const height = section.offsetHeight;
        const id = section.getAttribute('id');

        if (scrollY >= top && scrollY < top + height) {
            navLinks.forEach(link => {
                link.classList.remove('active');
                const href = link.getAttribute('href');
                if (href && href.endsWith('#' + id)) {
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

// Language toggle for legal pages
(function () {
    var toggle = document.getElementById('langToggle');
    if (!toggle) return;

    var STORAGE_KEY = 'legal-lang';
    var defaultLang = 'de';

    function setLang(lang) {
        document.querySelectorAll('.legal-content[data-lang]').forEach(function (el) {
            el.classList.toggle('active', el.getAttribute('data-lang') === lang);
        });
        toggle.querySelectorAll('.lang-option').forEach(function (opt) {
            opt.classList.toggle('active', opt.getAttribute('data-lang') === lang);
        });
        localStorage.setItem(STORAGE_KEY, lang);
    }

    var saved = localStorage.getItem(STORAGE_KEY);
    setLang(saved || defaultLang);

    toggle.addEventListener('click', function (e) {
        var target = e.target;
        if (target.classList.contains('lang-option')) {
            setLang(target.getAttribute('data-lang'));
        } else {
            var current = localStorage.getItem(STORAGE_KEY) || defaultLang;
            setLang(current === 'de' ? 'en' : 'de');
        }
    });
})();
