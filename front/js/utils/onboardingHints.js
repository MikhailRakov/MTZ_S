/**
 * Лёгкая система onboarding-подсказок.
 * Показывает tooltip-карточки на ключевых шагах, запоминает «больше не показывать»
 * в localStorage. Не зависит от внешних библиотек.
 *
 * Использование:
 *   import { showHint, hideAllHints } from './onboardingHints.js';
 *   showHint('upload-npz', buttonElement, 'Загрузите .npz файл с результатами SimPEG');
 */

const STORAGE_PREFIX = 'mtz_hint_dismissed_';
const HINT_CLASS = 'mtz-onboarding-hint';

/**
 * Показать подсказку рядом с элементом. Если пользователь уже закрыл её —
 * не показывать повторно.
 * @param {string} id - уникальный идентификатор подсказки
 * @param {HTMLElement} target - элемент, к которому привязать подсказку
 * @param {string} text - текст подсказки
 * @param {Object} [opts] - опции
 * @param {string} [opts.position='bottom'] - 'top' | 'bottom' | 'left' | 'right'
 * @param {number} [opts.autoHideMs=0] - автозакрытие через N мс (0 = только вручную)
 */
export function showHint(id, target, text, opts = {}) {
    if (!target || !document.body.contains(target)) return;
    if (isDismissed(id)) return;

    // Убираем предыдущую подсказку этого же id
    hideHint(id);

    const position = opts.position || 'bottom';
    const hint = document.createElement('div');
    hint.className = `${HINT_CLASS} ${HINT_CLASS}--${position}`;
    hint.dataset.hintId = id;
    hint.innerHTML = `
        <div class="${HINT_CLASS}__text">${text}</div>
        <button type="button" class="${HINT_CLASS}__close" aria-label="Закрыть">✕</button>
        <label class="${HINT_CLASS}__dismiss">
            <input type="checkbox" checked> Больше не показывать
        </label>
    `;

    document.body.appendChild(hint);
    positionHint(hint, target, position);

    // Закрытие
    const close = () => {
        const dismiss = hint.querySelector(`.${HINT_CLASS}__dismiss input`);
        if (dismiss && dismiss.checked) dismissHint(id);
        hint.remove();
    };
    hint.querySelector(`.${HINT_CLASS}__close`).addEventListener('click', close);

    // Автозакрытие
    if (opts.autoHideMs > 0) {
        setTimeout(close, opts.autoHideMs);
    }

    // Перепозиционирование при resize/scroll
    const reposition = () => {
        if (!document.body.contains(hint) || !document.body.contains(target)) {
            window.removeEventListener('resize', reposition);
            window.removeEventListener('scroll', reposition, true);
            return;
        }
        positionHint(hint, target, position);
    };
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
}

/** Скрыть конкретную подсказку. */
export function hideHint(id) {
    const existing = document.querySelector(`.${HINT_CLASS}[data-hint-id="${id}"]`);
    if (existing) existing.remove();
}

/** Скрыть все активные подсказки. */
export function hideAllHints() {
    document.querySelectorAll(`.${HINT_CLASS}`).forEach(el => el.remove());
}

/** Пометить подсказку как «больше не показывать». */
export function dismissHint(id) {
    try { localStorage.setItem(STORAGE_PREFIX + id, '1'); } catch (_) {}
}

/** Сбросить все dismissed-подсказки (для тестирования). */
export function resetAllHints() {
    try {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(STORAGE_PREFIX)) keys.push(k);
        }
        keys.forEach(k => localStorage.removeItem(k));
    } catch (_) {}
}

function isDismissed(id) {
    try { return localStorage.getItem(STORAGE_PREFIX + id) === '1'; } catch (_) { return false; }
}

function positionHint(hint, target, position) {
    const tr = target.getBoundingClientRect();
    const hr = hint.getBoundingClientRect();
    const gap = 8;
    let top, left;

    switch (position) {
        case 'top':
            top = tr.top - hr.height - gap;
            left = tr.left + (tr.width - hr.width) / 2;
            break;
        case 'left':
            top = tr.top + (tr.height - hr.height) / 2;
            left = tr.left - hr.width - gap;
            break;
        case 'right':
            top = tr.top + (tr.height - hr.height) / 2;
            left = tr.right + gap;
            break;
        default: // bottom
            top = tr.bottom + gap;
            left = tr.left + (tr.width - hr.width) / 2;
    }

    // Clamp to viewport
    left = Math.max(8, Math.min(left, window.innerWidth - hr.width - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - hr.height - 8));

    hint.style.top = `${top + window.scrollY}px`;
    hint.style.left = `${left + window.scrollX}px`;
}
