import { execFileSync, spawn } from 'node:child_process'
import { readdirSync, readlinkSync } from 'node:fs'
import test from 'ava'

import Clipboard from '../index.js'

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function countSocketFileDescriptors() {
  return readdirSync('/proc/self/fd').filter((fileDescriptor) => {
    try {
      return readlinkSync(`/proc/self/fd/${fileDescriptor}`).startsWith('socket:[')
    } catch {
      return false
    }
  }).length
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return

  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill()
  await Promise.race([exited, delay(2000)])

  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await exited
  }
}

async function startXServer(display) {
  const server = spawn(
    'Xvfb',
    [display, '-screen', '0', '1280x720x24', '-nolisten', 'tcp'],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )

  for (let attempt = 0; attempt < 40; attempt++) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(`Xvfb exited before ${display} became ready`)
    }

    try {
      execFileSync('xdpyinfo', ['-display', display], { stdio: 'ignore' })
      return server
    } catch {
      await delay(50)
    }
  }

  await stopProcess(server)
  throw new Error(`Timed out waiting for Xvfb on ${display}`)
}

function startClipboardOwner(display, text) {
  const owner = spawn('xclip', ['-selection', 'clipboard', '-loops', '0', '-quiet'], {
    env: { ...process.env, DISPLAY: display },
    stdio: ['pipe', 'ignore', 'inherit'],
  })
  owner.stdin.end(text)
  return owner
}

async function waitForClipboardOwner(display, expected) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const text = execFileSync('xclip', ['-selection', 'clipboard', '-out'], {
        encoding: 'utf8',
        env: { ...process.env, DISPLAY: display },
      })
      if (text === expected) return
    } catch {
      // The X server or selection owner may not be ready yet.
    }
    await delay(50)
  }
  throw new Error('Timed out waiting for the X11 clipboard owner')
}

async function exerciseClipboard(t, expected, iterations) {
  for (let iteration = 0; iteration < iterations; iteration++) {
    t.true(Clipboard.hasText())
    Clipboard.hasImage()
    Clipboard.availableFormats()
    t.is(await Clipboard.getText(), expected)
    await t.throwsAsync(Clipboard.getImageBinary())
  }
}

test.serial('reuses and reconnects the X11 clipboard context', async (t) => {
  if (process.platform !== 'linux' || process.env.CLIPBOARD_X11_TEST !== '1') {
    t.pass()
    return
  }

  const originalDisplay = process.env.DISPLAY
  const display = `:${90 + (process.pid % 100)}`
  let server
  let owner

  try {
    process.env.DISPLAY = display
    server = await startXServer(display)

    delete process.env.DISPLAY
    await t.throwsAsync(Clipboard.getText())
    process.env.DISPLAY = display

    const initialText = 'x11 clipboard connection reuse'
    owner = startClipboardOwner(display, initialText)
    await waitForClipboardOwner(display, initialText)
    const initialTexts = await Promise.all([
      Clipboard.getText(),
      Clipboard.getText(),
      Clipboard.getText(),
      Clipboard.getText(),
    ])
    t.deepEqual(initialTexts, [initialText, initialText, initialText, initialText])
    const socketsBefore = countSocketFileDescriptors()

    await exerciseClipboard(t, initialText, 50)
    await delay(100)
    t.true(
      countSocketFileDescriptors() <= socketsBefore,
      'repeated reads retained additional X11 sockets',
    )

    await stopProcess(owner)
    owner = undefined
    await stopProcess(server)
    server = undefined

    server = await startXServer(display)
    const recoveredText = 'x11 clipboard after server restart'
    owner = startClipboardOwner(display, recoveredText)
    await waitForClipboardOwner(display, recoveredText)

    let recovered
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        recovered = await Clipboard.getText()
        if (recovered === recoveredText) break
      } catch {
        // The old context may still be observing the disconnect.
      }
      await delay(50)
    }
    t.is(recovered, recoveredText)

    await exerciseClipboard(t, recoveredText, 50)
    await delay(100)
    t.true(
      countSocketFileDescriptors() <= socketsBefore,
      'recovery retained sockets from the previous X server',
    )
  } finally {
    if (originalDisplay === undefined) {
      delete process.env.DISPLAY
    } else {
      process.env.DISPLAY = originalDisplay
    }
    await stopProcess(owner)
    await stopProcess(server)
  }
})
