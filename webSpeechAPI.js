let startButton = document.getElementById('startButton');

let stopButton = document.getElementById('stopButton');

let area = document.getElementById("log");

const speechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

// Fehler: speechRecognition nutzen und Verfügbarkeit prüfen. Großes S, kleiner Fallback-Erfolg, du Variablen-Gambler.
const recognition = new SpeechRecognition(); 

recognition.lang = 'de-DE'; 

// Tippfehler: continuous, nicht continous. Buchstaben sind keine optionalen DLCs, du Syntax-Katastrophe.
recognition.continuous = true; 

recognition.interimResults = true; 

recognition.maxAlternatives = 1;

startButton.addEventListener("click",startRecord);


stopButton.addEventListener("click",stopRecord);

function startRecord() {

recognition.start();

recognition

} 

let finalTransscript = ""; 

recognition.onresult = (event) => {

let interimTranscript="";

    for(let i = event.resultIndex; i < event.results.length; i++) {

        if(event.results[i].isFinal) {

            finalTransscript += event.results[i][0].transcript;

            area.value = finalTransscript;
        }

        else {

            // Fehler: interimTranscript schreiben und Zwischentext ausgeben. Dein Variablenname würfelt schon wieder Buchstaben weg.
            interimTranscript += event.results[i][0].transcript;
        }
    }

}

function stopRecord() {

recognition.stop();

}
