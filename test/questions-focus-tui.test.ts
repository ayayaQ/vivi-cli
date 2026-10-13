// SPDX-License-Identifier: Apache-2.0
import { test, expect, afterEach } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { OpenTuiIO } from '../src/tui.js'
import { TextareaRenderable } from '@opentui/core'
const fixtures: OpenTuiIO[]=[]
afterEach(()=>{ for(const io of fixtures.splice(0)) io.close() })
const request=(id='review')=>({requestId:id,callId:`call-${id}`,questions:[{id:'q',header:'Route',question:'Choose a route',options:[{id:'a',label:'Route A'},{id:'b',label:'Route B'}]}]})
async function fixture(){
 const setup=await createTestRenderer({width:100,height:30,kittyKeyboard:true,exitOnCtrlC:false,exitSignals:[],consoleMode:'disabled'})
 const io=new OpenTuiIO(setup.renderer);fixtures.push(io)
 const frame=async()=>{await setup.renderOnce();await setup.renderOnce()}
 const arm=async()=>{await new Promise(r=>setTimeout(r,2));await frame()}
 const node=(id:string)=>setup.renderer.root.findDescendantById(id)!
 const click=async(id:string)=>{const n=node(id);await setup.mockMouse.click(n.x+1,n.y)}
 return {setup,io,frame,arm,node,click,input:setup.mockInput,mouse:setup.mockMouse}
}
test('terminal blur/focus interrupts an incomplete question Submit mouse gesture',async()=>{
 const f=await fixture();const answer=f.io.askQuestions(request(),new AbortController().signal);let result:unknown
 answer.then(v=>{result=v});await f.arm();await f.click('vivi-question-option-0');await f.frame()
 const submit=f.node('vivi-question-submit');await f.mouse.pressDown(submit.x+1,submit.y)
 f.setup.renderer.stdin.emit('data',Buffer.from('\x1b[O\x1b[I'));await f.frame()
 await f.mouse.release(submit.x+1,submit.y);await Promise.resolve();await Promise.resolve()
 expect(result).toBeUndefined()
 f.input.pressEscape();expect((await answer).status).toBe('cancelled')
})
test('aborting a suspended chat does not restore stale input after a question cancels',async()=>{
 const f=await fixture();const controller=new AbortController()
 const chat=f.io.readLine('Message',controller.signal).catch(e=>e.message)
 await f.input.pasteBracketedText('unsubmitted draft')
 const answer=f.io.askQuestions(request('chat-abort'),new AbortController().signal);await f.arm()
 controller.abort();expect(await chat).toBe('Input cancelled')
 f.input.pressEscape();expect((await answer).status).toBe('cancelled');await f.frame()
 const next=f.io.readLine('Fresh input');await f.frame()
 expect((f.node('vivi-composer') as TextareaRenderable).plainText).toBe('')
 f.input.pressEnter();expect(await next).toBe('')
})
test('run finish cancels every queued dialog and later fresh run accepts only its own input',async()=>{
 const f=await fixture();f.io.runStarted()
 const first=f.io.askQuestions(request('active'),new AbortController().signal)
 const second=f.io.askQuestions(request('queued'),new AbortController().signal);await f.arm()
 f.io.runFinished('completed');expect((await first).status).toBe('cancelled');expect((await second).status).toBe('cancelled')
 await f.frame();f.io.runStarted();const third=f.io.askQuestions(request('fresh'),new AbortController().signal);await f.arm()
 f.input.pressEnter();await f.frame();f.input.pressEnter()
 expect(await third).toEqual({requestId:'fresh',status:'answered',answers:[{id:'q',answer:{kind:'option',optionId:'a'}}]})
})


test('a fresh complete Submit click succeeds after terminal focus returns', async () => {
  const f = await fixture(), answer = f.io.askQuestions(request('fresh-focus'), new AbortController().signal)
  let result: unknown
  void answer.then(value => { result = value })
  await f.arm(); await f.click('vivi-question-option-1'); await f.frame()
  const submit = f.node('vivi-question-submit')
  await f.mouse.pressDown(submit.x + 1, submit.y)
  f.setup.renderer.stdin.emit('data', Buffer.from('\x1b[O\x1b[I')); await f.frame()
  await f.mouse.release(submit.x + 1, submit.y)
  await Promise.resolve(); await Promise.resolve()
  expect(result).toBeUndefined()
  await f.click('vivi-question-submit')
  expect(await answer).toEqual({ requestId: 'fresh-focus', status: 'answered',
    answers: [{ id: 'q', answer: { kind: 'option', optionId: 'b' } }] })
})
