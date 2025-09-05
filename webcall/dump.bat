@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

:: Игнорируемые папки
set "SKIP_DIRS=\venv\;.git\;__pycache__\;.mypy_cache\;.idea\;.vscode\;node_modules\;.pytest_cache\"

:: Игнорируемые файлы
set "SKIP_FILES=CACHEDIR.TAG"

set "OUT=project_dump.txt"

(
  echo === Dump started: %date% %time%
  echo Root: %cd%
  echo.
  echo === DIRECTORY TREE =======================================
  tree /F /A
  echo.
  echo === FILE CONTENTS =======================================
) > "%OUT%"

:: Обход файлов
for /R %%F in (*) do (
    set "FILE=%%~fF"
    call :ShouldSkip "%%F"
    if errorlevel 1 (
        REM skip
    ) else (
        >>"%OUT%" echo.
        >>"%OUT%" echo --- %%F ---
        >>"%OUT%" type "%%F"
    )
)

>>"%OUT%" echo.
>>"%OUT%" echo === Dump finished: %date% %time%

echo Структура и содержимое файлов сохранены в %OUT%
exit /b


:ShouldSkip
setlocal
set "FN=%~1"

:: Проверяем папки
for %%D in (%SKIP_DIRS%) do (
    echo "%FN%" | findstr /I "%%D" >nul && (exit /b 1)
)

:: Проверяем файлы
for %%X in (%SKIP_FILES%) do (
    if /I "%~nx1"=="%%X" exit /b 1
)

exit /b 0
