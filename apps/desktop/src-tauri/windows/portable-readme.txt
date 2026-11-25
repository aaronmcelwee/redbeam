REDBEAM portable

This is REDBEAM without an installer. Nothing is installed and no admin
rights are needed.

To use it
1. Unzip this folder somewhere of your own, such as Documents or the
   Desktop. Do not run REDBEAM.exe from inside the zip.
2. Double-click REDBEAM.exe.
3. If Windows says "Windows protected your PC", click "More info", then
   "Run anyway". REDBEAM is not code-signed, so Windows asks once.
   If Windows still refuses, right-click the zip before unzipping it,
   choose Properties, tick "Unblock", press OK, and unzip again.

Keep REDBEAM.portable beside REDBEAM.exe. It is how this copy knows it
is the portable one.

What is different from the installed copy
- Updates: REDBEAM tells you when a new version is out, and its button
  downloads the new portable zip. Unzip it over this folder.
- PDFs do not open in REDBEAM by double-clicking them, and REDBEAM is not
  listed under "Open with". Open PDFs from REDBEAM, or drag them onto
  REDBEAM.exe.
- No Start menu entry or uninstaller. To remove REDBEAM, delete this
  folder. Settings and recent files stay in
  %LOCALAPPDATA%\com.redbeam.app and %APPDATA%\com.redbeam.app.
- If you move this folder after turning on Settings > Claude and ChatGPT,
  turn it off and on again so those apps find REDBEAM.exe in its new place.

WebView2
REDBEAM draws its window with Microsoft Edge WebView2, which Windows 11
and any up-to-date Windows 10 already have. If a PC lacks it, REDBEAM says
so and offers Microsoft's download page. Where installing is blocked,
download the "Fixed Version" WebView2 runtime from that page and unzip it
into a folder named WebView2 beside REDBEAM.exe. REDBEAM uses it from there.
