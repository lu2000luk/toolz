import pyautogui as gui
import time

print("Spamming shift, CTRL+C or CTRL+Z here to stop")

while True:
    gui.keyDown("shift")
    time.sleep(0)
    gui.keyUp("shift")

