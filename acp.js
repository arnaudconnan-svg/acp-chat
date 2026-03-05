function reflect(message){

const text = message.trim()

if(text.length === 0){
return "Je reçois tes mots."
}

if(text.startsWith("Je ")){
return "Tu " + text.slice(3)
}

return "Tu dis : " + text

}

module.exports = {
reflect
}