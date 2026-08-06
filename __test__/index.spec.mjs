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

async function waitForClipboardOwner(expected) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const text = execFileSync('xclip', ['-selection', 'clipboard', '-out'], { encoding: 'utf8' })
      if (text === expected) return
    } catch {
      // The X11 selection owner may not be ready yet.
    }
    await delay(50)
  }
  throw new Error('Timed out waiting for the X11 clipboard owner')
}

test.serial('reuses one X11 connection across clipboard reads', async (t) => {
  if (process.platform !== 'linux' || !process.env.DISPLAY) {
    t.pass()
    return
  }

  const display = process.env.DISPLAY
  delete process.env.DISPLAY
  try {
    await t.throwsAsync(Clipboard.getText())
  } finally {
    process.env.DISPLAY = display
  }

  const expected = 'x11 clipboard connection reuse'
  const owner = spawn('xclip', ['-selection', 'clipboard', '-loops', '0', '-quiet'], {
    stdio: ['pipe', 'ignore', 'inherit'],
  })
  const ownerExited = new Promise((resolve) => owner.once('exit', resolve))
  owner.stdin.end(expected)

  try {
    await waitForClipboardOwner(expected)
    const initialTexts = await Promise.all([
      Clipboard.getText(),
      Clipboard.getText(),
      Clipboard.getText(),
      Clipboard.getText(),
    ])
    t.deepEqual(initialTexts, [expected, expected, expected, expected])
    Clipboard.hasText()
    Clipboard.hasImage()
    Clipboard.availableFormats()
    const socketsBefore = countSocketFileDescriptors()

    for (let iteration = 0; iteration < 50; iteration++) {
      t.true(Clipboard.hasText())
      Clipboard.hasImage()
      Clipboard.availableFormats()
      t.is(await Clipboard.getText(), expected)
      await t.throwsAsync(Clipboard.getImageBinary())
    }

    await delay(100)
    const socketsAfter = countSocketFileDescriptors()
    t.true(
      socketsAfter <= socketsBefore,
      `repeated reads increased socket FDs from ${socketsBefore} to ${socketsAfter}`,
    )
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) {
      owner.kill()
      await ownerExited
    }
  }
})
