/**
 * Тесты для доступности функций редактора калибровочных кривых.
 * Проверяет, что disableCalCurvesEditor экспортируется и может быть вызвана
 * извне initPhoenixImport (например, из resetCoarseGenerator).
 *
 * Запуск: node --test MTZ_S/tests/js/*.test.js  (или: cd MTZ_S/tests/js && node --test)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Импортируем все экспорты модуля
const moduleExports = await import('../../front/js/utils/dashboardCoarseIntegration.js');

describe('calCurvesEditor scope', () => {
    test('disableCalCurvesEditor должен быть экспортирован из модуля', () => {
        assert.ok(
            typeof moduleExports.disableCalCurvesEditor === 'function',
            'disableCalCurvesEditor должна быть экспортирована как функция'
        );
    });

    test('disableCalCurvesEditor не должен падать при вызове без инициализации', () => {
        // Вызов до initPhoenixImport не должен бросать ошибку
        assert.doesNotThrow(() => {
            moduleExports.disableCalCurvesEditor();
        }, 'Вызов без инициализации не должен падать');
    });

    test('disableCalCurvesEditor должен вызываться многократно без ошибок', () => {
        assert.doesNotThrow(() => {
            moduleExports.disableCalCurvesEditor();
            moduleExports.disableCalCurvesEditor();
            moduleExports.disableCalCurvesEditor();
        }, 'Многократный вызов не должен падать');
    });
});

console.log('Запуск тестов calCurvesEditorScope...');
