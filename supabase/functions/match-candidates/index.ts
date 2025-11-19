import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Parse request body first
  let jobDescription: string;
  try {
    const body = await req.json();
    jobDescription = body.jobDescription;
  } catch (error) {
    return new Response(
      JSON.stringify({ error: 'Invalid request body' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  if (!jobDescription) {
    return new Response(
      JSON.stringify({ error: 'Job description is required' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Create SSE stream
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (event: string, data: any) => {
        const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(message));
      };

      try {
        sendEvent('log', { level: 'info', message: 'Starting candidate matching...' });
        console.log('Starting candidate matching...');

        const supabaseClient = createClient(
          Deno.env.get('SUPABASE_URL') ?? '',
          Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        );

        const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY');
        if (!GEMINI_API_KEY) {
          sendEvent('error', { message: 'GEMINI_API_KEY not configured' });
          controller.close();
          return;
        }

        sendEvent('log', { level: 'info', message: 'Fetching candidate profiles...' });

        // Get authenticated user ID from the JWT
        const authHeader = req.headers.get('Authorization');
        const token = authHeader?.replace('Bearer ', '');
        const { data: { user }, error: userError } = await supabaseClient.auth.getUser(token || '');
        
        if (userError || !user) {
          sendEvent('error', { message: 'Unable to authenticate user' });
          controller.close();
          return;
        }

        // Fetch only the candidate profiles uploaded by this user
        const { data: profiles, error: fetchError } = await supabaseClient
          .from('profiles')
          .select('*')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(100);

        if (fetchError) {
          console.error('Fetch error:', fetchError);
          sendEvent('error', { message: 'Failed to fetch profiles' });
          controller.close();
          return;
        }

        if (!profiles || profiles.length === 0) {
          sendEvent('log', { level: 'info', message: 'No candidates found in database' });
          sendEvent('complete', { matches: [], message: 'No candidates found' });
          controller.close();
          return;
        }

        sendEvent('log', { level: 'info', message: `Found ${profiles.length} candidates` });
        sendEvent('progress', { current: 0, total: profiles.length });
        console.log(`Processing ${profiles.length} candidates in batches...`);

        // Process in batches of 5 candidates with parallel processing
        const BATCH_SIZE = 5;
        const PARALLEL_BATCHES = 3; // Process 3 batches in parallel
        const allRankedCandidates: any[] = [];
        
        // Process batches in parallel (3 at a time) for faster execution
        const totalBatches = Math.ceil(profiles.length / BATCH_SIZE);
        
        for (let batchStart = 0; batchStart < profiles.length; batchStart += BATCH_SIZE * PARALLEL_BATCHES) {
          const parallelBatches = [];
          
          for (let j = 0; j < PARALLEL_BATCHES; j++) {
            const i = batchStart + (j * BATCH_SIZE);
            if (i >= profiles.length) break;
            
            const batchProfiles = profiles.slice(i, Math.min(i + BATCH_SIZE, profiles.length));
            const batchNum = Math.floor(i / BATCH_SIZE) + 1;
            
            parallelBatches.push((async () => {
              sendEvent('log', { level: 'info', message: `Processing batch ${batchNum}/${totalBatches} (${batchProfiles.length} candidates)...` });
              console.log(`Processing batch ${batchNum}/${totalBatches} (${batchProfiles.length} candidates)...`);
              
              // Prepare candidate summaries with optimized snippets
              const candidateSummaries = batchProfiles.map((profile, index) => {
                const text = (profile.resume_text || '').toString();
                const snippet = text.length > 1000 ? text.slice(0, 1000) + '...' : text;
                return {
                  index: i + index,
                  resume: snippet
                };
              });

              // Process batch with Gemini Flash
              let batchRanked: any[] = [];
              const maxRetries = 3;
              
              for (let attempt = 0; attempt < maxRetries; attempt++) {
                try {
                  const response = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
                    {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        contents: [{
                          parts: [{
                            text: `Job Description:\n${jobDescription}\n\nCandidates:\n${JSON.stringify(candidateSummaries)}\n\nAnalyze each candidate against the job description. Return ONLY a valid JSON object with this EXACT structure:\n{\n  "candidates": [\n    {\n      "candidateIndex": <number>,\n      "fullName": "<string>",\n      "email": "<string or null>",\n      "phone": "<string or null>",\n      "location": "<string or null>",\n      "jobTitle": "<string or null>",\n      "yearsOfExperience": <number or null>,\n      "matchScore": <number 0-100>,\n      "reasoning": "<string max 80 chars>",\n      "strengths": ["<string>", "<string>", "<string>"],\n      "concerns": ["<string>", "<string>", "<string>"]\n    }\n  ]\n}\n\nIMPORTANT: reasoning max 80 chars, max 3 items in strengths/concerns arrays.`
                          }]
                        }],
                        generationConfig: {
                          temperature: 0.3,
                          topK: 40,
                          topP: 0.95,
                          maxOutputTokens: 16000,
                        },
                        safetySettings: [
                          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
                        ]
                      })
                    }
                  );

                  if (!response.ok) {
                    const errorText = await response.text();
                    if (response.status === 429) {
                      throw new Error('Rate limited - will retry');
                    }
                    throw new Error(`API error: ${response.status} - ${errorText}`);
                  }

                  const result = await response.json();
                  
                  if (!result.candidates?.[0]?.content?.parts?.[0]?.text) {
                    if (result.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
                      throw new Error('Response exceeded token limit - try reducing batch size or resume length');
                    }
                    throw new Error('Invalid response structure from Gemini');
                  }

                  let jsonText = result.candidates[0].content.parts[0].text.trim();
                  jsonText = jsonText.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
                  
                  let parsed;
                  try {
                    parsed = JSON.parse(jsonText);
                  } catch (parseError) {
                    console.error('JSON parse failed. Raw text:', jsonText);
                    throw new Error('Failed to parse AI response as JSON');
                  }

                  if (!parsed.candidates || !Array.isArray(parsed.candidates)) {
                    throw new Error('Response missing candidates array');
                  }

                  batchRanked = parsed.candidates.map((candidate: any) => ({
                    candidateIndex: candidate.candidateIndex,
                    fullName: candidate.fullName || null,
                    email: candidate.email || null,
                    phone: candidate.phone || null,
                    location: candidate.location || null,
                    jobTitle: candidate.jobTitle || null,
                    yearsOfExperience: candidate.yearsOfExperience || null,
                    matchScore: candidate.matchScore || 50,
                    reasoning: candidate.reasoning || 'Analyzed',
                    strengths: candidate.strengths || [],
                    concerns: candidate.concerns || []
                  }));
                  
                  sendEvent('log', { level: 'success', message: `Successfully processed batch ${batchNum} (${batchProfiles.length} candidates)` });
                  sendEvent('progress', { current: Math.min(i + BATCH_SIZE, profiles.length), total: profiles.length });
                  console.log(`Successfully processed batch ${batchNum} (${batchProfiles.length} candidates)`);
                  break;
                  
                } catch (error: any) {
                  sendEvent('log', { level: 'error', message: `Batch ${batchNum} attempt ${attempt + 1} failed: ${error.message}` });
                  console.error(`Batch ${batchNum} attempt ${attempt + 1} failed:`, error);
                  
                  if (attempt === maxRetries - 1) {
                    console.log(`Creating fallback results for batch ${batchNum}`);
                    batchRanked = candidateSummaries.map(c => ({
                      candidateIndex: c.index,
                      fullName: `Candidate ${c.index + 1}`,
                      email: null,
                      phone: null,
                      location: null,
                      jobTitle: null,
                      yearsOfExperience: null,
                      matchScore: 0,
                      reasoning: 'Analysis failed - manual review needed',
                      strengths: [],
                      concerns: ['Automated analysis unavailable']
                    }));
                  } else {
                    await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt + 1) * 1000));
                  }
                }
              }
              
              return batchRanked;
            })());
          }
          
          const batchResults = await Promise.all(parallelBatches);
          batchResults.forEach(result => allRankedCandidates.push(...result));
        }

        sendEvent('log', { level: 'info', message: `All batches processed. Total candidates: ${allRankedCandidates.length}` });
        console.log(`All batches processed. Total candidates: ${allRankedCandidates.length}`);

        allRankedCandidates.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));

        // Merge with profile data and prepare bulk database updates
        const matches = allRankedCandidates.map((ranked: any) => {
          const profile = profiles[ranked.candidateIndex];
          
          if (!profile) {
            console.error(`Profile not found for index ${ranked.candidateIndex}`);
            return null;
          }
          
          const isFallback = ranked.reasoning === 'Analysis failed - manual review needed';
          
          return {
            id: profile.id,
            resume_file_url: profile.resume_file_url,
            resume_text: profile.resume_text,
            created_at: profile.created_at,
            full_name: ranked.fullName || 'Not extracted',
            email: ranked.email || null,
            phone_number: ranked.phone || null,
            location: ranked.location || null,
            job_title: ranked.jobTitle || null,
            years_of_experience: ranked.yearsOfExperience || null,
            matchScore: isFallback ? 0 : ranked.matchScore,
            reasoning: ranked.reasoning,
            strengths: ranked.strengths || [],
            concerns: ranked.concerns || [],
            isFallback,
            shouldUpdate: !isFallback && ranked.fullName && ranked.fullName !== 'Not extracted'
          };
        }).filter(m => m !== null);

        sendEvent('log', { level: 'info', message: 'Updating candidate profiles...' });

        // Bulk update profiles (optimized with Promise.allSettled)
        const updatePromises = matches
          .filter(m => m.shouldUpdate)
          .map(m => {
            const updateData: any = {};
            if (m.full_name) updateData.full_name = m.full_name;
            if (m.email) updateData.email = m.email;
            if (m.phone_number) updateData.phone_number = m.phone_number;
            if (m.location) updateData.location = m.location;
            if (m.job_title) updateData.job_title = m.job_title;
            if (m.years_of_experience) updateData.years_of_experience = m.years_of_experience;
            
            if (Object.keys(updateData).length > 0) {
              return supabaseClient
                .from('profiles')
                .update(updateData)
                .eq('id', m.id);
            }
            return null;
          })
          .filter(p => p !== null);
        
        await Promise.allSettled(updatePromises);

        const validMatches = matches.filter(m => !m.isFallback);
        const fallbackCount = matches.filter(m => m.isFallback).length;
        const successCount = validMatches.length;
        
        sendEvent('log', { level: 'success', message: `Successfully matched ${successCount} candidates, ${fallbackCount} fallback` });
        console.log(`Successfully matched ${successCount} candidates, ${fallbackCount} fallback`);

        sendEvent('complete', { 
          matches: validMatches,
          total: profiles.length,
          message: `Successfully matched ${successCount} candidates`
        });

        controller.close();

      } catch (error) {
        console.error('Error in match-candidates function:', error);
        sendEvent('error', { message: error instanceof Error ? error.message : 'Unknown error' });
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    }
  });
});
